import {
  A2A_VERSION_HEADER,
  AgentCard,
  formatSSEEvent,
  HTTP_EXTENSION_HEADER,
  SendMessageRequest,
  SSE_HEADERS,
} from '@a2a-js/sdk';
import { MessagingError } from '@dispatch/protocol';
import type { JsonValue } from '@dispatch/protocol';
import { randomUUID } from 'node:crypto';

import { buildCard, cardEtag, JWKS_PATH } from '../card.js';
import { decodeInbound, outputTextType } from '../codec.js';
import {
  A2AError,
  authFailure,
  errorResponse,
  HttpFailure,
  rateLimited,
} from '../errors.js';
import { activatedExtensions, utf8Bytes } from '../ext.js';
import type {
  A2APolicy,
  BridgePort,
  Caller,
  ExtensionRoute,
  OpenResult,
  TaskFacts,
} from '../port.js';
import { decideState, project, withReask } from '../projection.js';
import type { ProjectionView } from '../projection.js';
import { parsePushConfig, pushConfigJson } from '../push.js';
import type { PushConfigInput } from '../push.js';
import { stateFromWire, TERMINAL_STATES } from '../states.js';
import { ENVELOPE_URI } from '../uris.js';
import type { ExtensionUri } from '../uris.js';
import type { MessageJson, PartJson, TaskJson } from '../wire.js';
import type { IpLimiter } from './limits.js';
import { taskEventStream } from './sse.js';
import { waitForSettled } from './wait.js';

export interface HandleOptions {
  basePath: '/a2a/v1';
  policy: A2APolicy;
  // The host resolves X-Forwarded-For.
  clientIp: string | null;
  // One per listener, so per-IP state outlives a request.
  limiter: IpLimiter;
  // The daemon's srv.timeout(req, s).
  setRequestTimeout?: (seconds: number) => void;
  now?: () => Date;
}

export type Route =
  | { op: 'send' | 'stream' | 'list' | 'extendedCard' }
  | { op: 'get' | 'cancel' | 'subscribe'; id: string }
  | PushRoute;

type PushRoute =
  | { op: 'pushCreate' | 'pushList'; id: string }
  | { op: 'pushGet' | 'pushDelete'; id: string; configId: string };

interface Op {
  req: Request;
  url: URL;
  port: BridgePort;
  options: HandleOptions;
  caller: Caller;
  stillAllowed: () => Promise<boolean>;
}

const MAX_BODY_BYTES = 256 * 1024;
// <base>/dispatch/<route>, the Dispatch extension routes.
const EXTENSION = /^\/dispatch\/(pair|unpair|key-change|upgrade)$/;
/** Where a peer that missed a rotation's push finds the statement. */
export const KEY_STATEMENT_PATH = '/.well-known/dispatch-a2a-key-change.json';
const CARD_PATH = '/.well-known/agent-card.json';
const QUERY_CREDENTIALS = [
  'token',
  'access_token',
  'api_key',
  'apikey',
  'key',
  'authorization',
  'bearer',
];
const TASK_PATH =
  /^\/tasks\/([^/:]+)(:cancel|:subscribe|\/pushNotificationConfigs(?:\/([^/]+))?)?$/;

function decodeId(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

// Maps a method and a path under basePath to an operation; null is a 404.
export function matchRoute(method: string, path: string): Route | null {
  if (method === 'POST' && path === '/message:send') return { op: 'send' };
  if (method === 'POST' && path === '/message:stream') return { op: 'stream' };
  if (method === 'GET' && path === '/tasks') return { op: 'list' };
  if (method === 'GET' && path === '/extendedAgentCard')
    return { op: 'extendedCard' };
  const m = TASK_PATH.exec(path);
  const id = m === null ? null : decodeId(m[1]);
  if (m === null || id === null) return null;
  if (m[2] === undefined) return method === 'GET' ? { op: 'get', id } : null;
  if (m[2] === ':cancel')
    return method === 'POST' ? { op: 'cancel', id } : null;
  if (m[2] === ':subscribe')
    return method === 'GET' || method === 'POST'
      ? { op: 'subscribe', id }
      : null;
  if (m[3] === undefined)
    return method === 'POST'
      ? { op: 'pushCreate', id }
      : method === 'GET'
        ? { op: 'pushList', id }
        : null;
  const configId = decodeId(m[3]);
  if (configId === null) return null;
  return method === 'GET'
    ? { op: 'pushGet', id, configId }
    : method === 'DELETE'
      ? { op: 'pushDelete', id, configId }
      : null;
}

// Names the activated extensions on a response, as A2A-Extensions.
function withExtensions(
  res: Response,
  extensions: ReadonlySet<string>
): Response {
  if (extensions.size > 0)
    res.headers.set(HTTP_EXTENSION_HEADER, [...extensions].join(', '));
  return res;
}

function json(body: unknown, extensions: ReadonlySet<string>): Response {
  return withExtensions(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    extensions
  );
}

// An empty header or query value counts as absent.
function present(value: string | null): string | null {
  return value === '' ? null : value;
}

// A2A 1.0 with any patch, from the header or the query; missing means 0.3.
function checkVersion(req: Request, url: URL): void {
  const raw =
    present(req.headers.get(A2A_VERSION_HEADER)) ??
    url.searchParams.get(A2A_VERSION_HEADER) ??
    '';
  const [major, minor] = raw.trim().split('.');
  if (major !== '1' || minor !== '0') {
    throw new A2AError(
      'VERSION_NOT_SUPPORTED',
      'this agent speaks A2A 1.0; send A2A-Version: 1.0'
    );
  }
}

// The request body for a signature check, under the same 256 KiB cap.
async function readBytes(req: Request): Promise<Uint8Array> {
  const tooLarge = () =>
    new HttpFailure(new Response('request body over 256 KiB', { status: 413 }));
  if (Number(req.headers.get('content-length') ?? '0') > MAX_BODY_BYTES)
    throw tooLarge();
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) throw tooLarge();
  return bytes;
}

interface Authenticated {
  caller: Caller;
  // The request to serve: rebuilt when the body was read for a signature.
  req: Request;
  stillAllowed: () => Promise<boolean>;
  // Set when the caller signed: its response is signed in turn.
  signed: boolean;
}

// A Dispatch signature decides on its own when present (a bearer beside it
// is ignored); otherwise the bearer resolves through the port. Only failing
// requests count toward the per-IP lockout, so a valid caller behind a
// shared tunnel IP always passes.
async function authenticate(
  original: Request,
  url: URL,
  port: BridgePort,
  options: HandleOptions
): Promise<Authenticated | Response> {
  const queryKeys = [...url.searchParams.keys()].map((k) => k.toLowerCase());
  if (queryKeys.some((k) => QUERY_CREDENTIALS.includes(k))) {
    throw new MessagingError(
      'invalid',
      'send the token in the Authorization header, never in the query string',
      'query'
    );
  }
  const fail = (code: 401 | 403, reason: string, message: string): Response => {
    options.limiter.authFailed(options.clientIp);
    const locked = options.limiter.lockedFor(options.clientIp);
    return locked === null
      ? authFailure(code, reason, message)
      : rateLimited(locked);
  };
  let req = original;
  if (
    port.authenticateSigned !== undefined &&
    req.headers.has('signature-input')
  ) {
    const body =
      req.method === 'GET' || req.method === 'HEAD'
        ? null
        : await readBytes(req);
    if (body !== null)
      req = new Request(original.url, {
        method: original.method,
        headers: original.headers,
        body,
        signal: original.signal,
      });
    const signed = await port.authenticateSigned({
      method: req.method,
      path: url.pathname,
      query: url.search,
      headers: req.headers,
      body,
    });
    if (signed !== null) {
      if (!signed.ok) {
        if (signed.verified === undefined)
          return fail(
            signed.status === 403 ? 403 : 401,
            signed.reason,
            signed.message
          );
        // A verified signer's refusal is signed and never counts toward the IP lockout.
        const refusal =
          signed.status === 429
            ? rateLimited(signed.retryAfterSec ?? 1)
            : authFailure(signed.status, signed.reason, signed.message);
        return port.signResponse === undefined
          ? refusal
          : await port.signResponse(refusal, req, signed.verified);
      }
      const caller = signed.caller;
      return {
        caller,
        req,
        stillAllowed: () => port.revalidate?.(caller) ?? Promise.resolve(false),
        signed: true,
      };
    }
  }
  const header = req.headers.get('authorization') ?? '';
  const bearer = /^Bearer[ ]+(\S+)$/i.exec(header.trim())?.[1] ?? null;
  if (bearer === null)
    return fail(
      401,
      'AUTH_MISSING_TOKEN',
      'send Authorization: Bearer <token>'
    );
  const presented = (req.headers.get('a2a-extensions') ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter((u) => u !== '');
  const result = await (presented.length === 0
    ? port.authenticate(bearer)
    : port.authenticate(bearer, presented));
  if (!result.ok)
    return fail(
      result.status === 403 ? 403 : 401,
      result.reason,
      result.message
    );
  return {
    caller: result.caller,
    req,
    stillAllowed: async () => (await port.authenticate(bearer)).ok,
    signed: false,
  };
}

async function readJson(req: Request): Promise<unknown> {
  const type = (req.headers.get('content-type') ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (type !== 'application/json' && type !== 'application/a2a+json') {
    throw new HttpFailure(
      new Response('send application/json', { status: 415 })
    );
  }
  const tooLarge = () =>
    new HttpFailure(new Response('request body over 256 KiB', { status: 413 }));
  if (Number(req.headers.get('content-length') ?? '0') > MAX_BODY_BYTES)
    throw tooLarge();
  const text = await req.text();
  if (utf8Bytes(text) > MAX_BODY_BYTES) throw tooLarge();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new A2AError('INVALID_PARAMS', 'the request body is not JSON');
  }
}

function parseSendRequest(body: unknown): SendMessageRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new A2AError(
      'INVALID_PARAMS',
      'expected a SendMessageRequest object'
    );
  }
  try {
    return SendMessageRequest.fromJSON(body);
  } catch {
    throw new A2AError('INVALID_PARAMS', 'not a valid SendMessageRequest');
  }
}

// A non-empty query parameter in camelCase or snake_case, since HTTP+JSON
// gateways send either.
function param(url: URL, camel: string): string | null {
  const snake = camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  return (
    present(url.searchParams.get(camel)) ?? present(url.searchParams.get(snake))
  );
}

function intParam(url: URL, name: string): number | null {
  const raw = param(url, name);
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new MessagingError(
      'invalid',
      `${name}: expected a non-negative integer`,
      `query.${name}`
    );
  }
  return n;
}

function taskView(
  op: Op,
  extensions: ReadonlySet<ExtensionUri>,
  historyLength: number | null,
  includeArtifacts: boolean,
  textMediaType: ProjectionView['textMediaType'] = 'text/markdown'
): ProjectionView {
  return {
    client: op.caller.address,
    extensions,
    textMediaType,
    historyLength,
    includeArtifacts,
  };
}

async function mustFacts(op: Op, id: string): Promise<TaskFacts> {
  const facts = await op.port.facts(op.caller, id);
  if (facts === null) throw new A2AError('TASK_NOT_FOUND', 'task not found');
  return facts;
}

// A send that opened no task, as one agent message about what was delivered.
function directReply(
  result: Extract<OpenResult, { kind: 'reply' }>,
  view: ProjectionView
): MessageJson {
  const parts: PartJson[] = [
    { text: result.text, mediaType: view.textMediaType },
  ];
  if (result.data !== undefined)
    parts.push({ data: result.data, mediaType: 'application/json' });
  const out: MessageJson = {
    messageId:
      result.about === undefined
        ? `reply-${randomUUID()}`
        : `${result.about.id}~delivered`,
    role: 'ROLE_AGENT',
    parts,
  };
  if (result.about !== undefined) {
    out.contextId = result.about.thread;
    if (view.extensions.has(ENVELOPE_URI)) {
      out.metadata = {
        [ENVELOPE_URI]: {
          id: result.about.id,
          thread: result.about.thread,
        } as JsonValue,
      };
      out.extensions = [ENVELOPE_URI];
    }
  }
  return out;
}

// A blocking send waits for a settled task, at most blockingWaitSec, and
// keeps the request alive a little past that.
async function settle(op: Op, taskId: string): Promise<TaskFacts> {
  const waitSec = op.options.policy.blockingWaitSec;
  op.options.setRequestTimeout?.(waitSec + 5);
  const facts = await waitForSettled(op.port, op.caller, taskId, {
    maxMs: waitSec * 1000,
    signal: op.req.signal,
  });
  if (facts === null) throw new A2AError('TASK_NOT_FOUND', 'task not found');
  return facts;
}

// Takes one of the caller's stream slots; the function it returns frees it.
async function admitStream(op: Op): Promise<(() => void) | Response> {
  const admitted = await op.port.admit(op.caller, 'stream');
  if (!admitted.ok) return rateLimited(admitted.retryAfterSec);
  return admitted.release ?? (() => {});
}

// Streams the task on the admitted slot (freed here if the stream cannot
// start); a streamed send also ends at INPUT_REQUIRED, a subscription does not.
function openStream(
  op: Op,
  release: () => void,
  taskId: string,
  view: ProjectionView,
  reask: string | null,
  untilTerminal: boolean
): Response {
  op.options.setRequestTimeout?.(0);
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };
  try {
    return withExtensions(
      taskEventStream({
        port: op.port,
        caller: op.caller,
        stillAllowed: op.stillAllowed,
        taskId,
        view,
        reask,
        untilTerminal,
        release: releaseOnce,
        signal: op.req.signal,
      }),
      view.extensions
    );
  } catch (err) {
    releaseOnce();
    throw err;
  }
}

// SendMessage and SendStreamingMessage: a taskId continues that open task,
// anything else opens one. A stream is admitted before anything is sent.
async function send(op: Op, streaming: boolean): Promise<Response> {
  const request = parseSendRequest(await readJson(op.req));
  if (request.message === undefined)
    throw new MessagingError('invalid', 'message: required', 'message');
  const extensions = activatedExtensions(
    op.req.headers.get(HTTP_EXTENSION_HEADER),
    request.message.extensions
  );
  const view = taskView(
    op,
    extensions,
    request.configuration?.historyLength ?? null,
    true,
    outputTextType(request.configuration?.acceptedOutputModes ?? [])
  );
  const inbound = decodeInbound(request.message);
  // An inline push config is checked before anything is sent, and created
  // for the task once it exists.
  const inline = request.configuration?.taskPushNotificationConfig;
  const pushInput: PushConfigInput | null =
    inline === undefined || inline.url === '' ? null : parsePushConfig(inline);
  if (pushInput !== null) {
    if (op.port.pushConfigs === undefined)
      throw new A2AError(
        'PUSH_NOTIFICATION_NOT_SUPPORTED',
        'push notifications are not supported'
      );
    await op.port.pushConfigs.check(
      op.caller,
      pushInput,
      inbound.kind === 'continue' ? inbound.input.taskId : null
    );
  }
  let release: (() => void) | null = null;
  if (streaming) {
    const admitted = await admitStream(op);
    if (admitted instanceof Response) return admitted;
    release = admitted;
  }
  let taskId: string;
  let reask: string | null = null;
  try {
    if (inbound.kind === 'continue') {
      const before = await mustFacts(op, inbound.input.taskId);
      if (TERMINAL_STATES.has(decideState(before).state)) {
        throw new A2AError(
          'UNSUPPORTED_OPERATION',
          'this task is finished; start a new one'
        );
      }
      if (
        inbound.input.contextId !== null &&
        inbound.input.contextId !== before.contextId
      ) {
        throw new MessagingError(
          'invalid',
          'unknown contextId',
          'message.contextId'
        );
      }
      reask = (await op.port.continue(op.caller, inbound.input)).reask;
      taskId = inbound.input.taskId;
    } else {
      const opened = await op.port.open(op.caller, inbound.input);
      if (opened.kind === 'reply') {
        const message = directReply(opened, view);
        if (release === null) return json({ message }, extensions);
        release();
        return withExtensions(
          new Response(formatSSEEvent({ message }), { headers: SSE_HEADERS }),
          extensions
        );
      }
      taskId = opened.taskId;
    }
  } catch (err) {
    release?.();
    throw err;
  }
  if (pushInput !== null) {
    try {
      await op.port.pushConfigs?.create(op.caller, taskId, pushInput);
    } catch (err) {
      release?.();
      throw err;
    }
  }
  if (release !== null)
    return openStream(op, release, taskId, view, reask, false);
  const facts =
    request.configuration?.returnImmediately === true
      ? await mustFacts(op, taskId)
      : await settle(op, taskId);
  return json(
    { task: withReask(project(facts, view), reask, view) },
    extensions
  );
}

// The four push-config operations on one of the caller's tasks. A config is
// read back without its token or credentials.
async function push(op: Op, route: PushRoute): Promise<Response> {
  const configs = op.port.pushConfigs;
  if (configs === undefined)
    throw new A2AError(
      'PUSH_NOTIFICATION_NOT_SUPPORTED',
      'push notifications are not supported'
    );
  await mustFacts(op, route.id);
  const none = new Set<ExtensionUri>();
  switch (route.op) {
    case 'pushCreate': {
      const input = parsePushConfig(await readJson(op.req));
      return json(
        pushConfigJson(await configs.create(op.caller, route.id, input)),
        none
      );
    }
    case 'pushList':
      return json(
        {
          configs: (await configs.list(op.caller, route.id)).map(
            pushConfigJson
          ),
          nextPageToken: '',
        },
        none
      );
    case 'pushGet': {
      const found = await configs.get(op.caller, route.id, route.configId);
      if (found === null)
        throw new A2AError(
          'TASK_NOT_FOUND',
          'push notification config not found'
        );
      return json(pushConfigJson(found), none);
    }
    case 'pushDelete':
      await configs.delete(op.caller, route.id, route.configId);
      return json({}, none);
  }
}

// SubscribeToTask, by GET or POST: a stream of an unfinished task.
async function subscribe(op: Op, id: string): Promise<Response> {
  const facts = await mustFacts(op, id);
  if (TERMINAL_STATES.has(decideState(facts).state)) {
    throw new A2AError(
      'UNSUPPORTED_OPERATION',
      'this task is finished; there is nothing to subscribe to'
    );
  }
  const extensions = activatedExtensions(
    op.req.headers.get(HTTP_EXTENSION_HEADER)
  );
  const admitted = await admitStream(op);
  if (admitted instanceof Response) return admitted;
  return openStream(
    op,
    admitted,
    id,
    taskView(op, extensions, null, true),
    null,
    true
  );
}

async function getTask(op: Op, id: string): Promise<Response> {
  const extensions = activatedExtensions(
    op.req.headers.get(HTTP_EXTENSION_HEADER)
  );
  const view = taskView(
    op,
    extensions,
    intParam(op.url, 'historyLength'),
    true
  );
  return json(project(await mustFacts(op, id), view), extensions);
}

// ListTasks over the caller's own tasks; the port pages, this projects each.
async function listTasks(op: Op): Promise<Response> {
  const extensions = activatedExtensions(
    op.req.headers.get(HTTP_EXTENSION_HEADER)
  );
  // Absent or 0 means the default page.
  const asked = intParam(op.url, 'pageSize');
  const pageSize = asked === null || asked === 0 ? 50 : Math.min(asked, 100);
  const statusRaw = param(op.url, 'status');
  const state =
    statusRaw === null ? undefined : (stateFromWire(statusRaw) ?? undefined);
  if (statusRaw !== null && state === undefined)
    throw new MessagingError(
      'invalid',
      'status: not a task state',
      'query.status'
    );
  const afterRaw = param(op.url, 'statusTimestampAfter');
  let after: string | undefined;
  if (afterRaw !== null) {
    const t = Date.parse(afterRaw);
    if (Number.isNaN(t)) {
      throw new MessagingError(
        'invalid',
        'statusTimestampAfter: not a timestamp',
        'query.statusTimestampAfter'
      );
    }
    after = new Date(t).toISOString();
  }
  const contextId = param(op.url, 'contextId') ?? undefined;
  const pageToken = param(op.url, 'pageToken') ?? undefined;
  const page = await op.port.list(op.caller, {
    pageSize,
    ...(contextId === undefined ? {} : { contextId }),
    ...(state === undefined ? {} : { state }),
    ...(after === undefined ? {} : { after }),
    ...(pageToken === undefined ? {} : { pageToken }),
  });
  const view = taskView(
    op,
    extensions,
    intParam(op.url, 'historyLength'),
    param(op.url, 'includeArtifacts') === 'true'
  );
  const tasks: TaskJson[] = [];
  for (const id of page.ids) {
    const facts = await op.port.facts(op.caller, id);
    if (facts !== null) tasks.push(project(facts, view));
  }
  return json(
    {
      tasks,
      nextPageToken: page.nextPageToken,
      pageSize,
      totalSize: page.totalSize,
    },
    extensions
  );
}

async function cancelTask(op: Op, id: string): Promise<Response> {
  await mustFacts(op, id);
  await op.port.cancel(op.caller, id);
  const extensions = activatedExtensions(
    op.req.headers.get(HTTP_EXTENSION_HEADER)
  );
  return json(
    project(await mustFacts(op, id), taskView(op, extensions, null, true)),
    extensions
  );
}

// The public card: unauthenticated, rate limited per IP, cacheable by ETag.
async function serveCard(
  req: Request,
  port: BridgePort,
  options: HandleOptions
): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD')
    return new Response(null, { status: 405 });
  const wait = options.limiter.allowCard(options.clientIp);
  if (wait !== null) return rateLimited(wait);
  const card = buildCard(await port.card());
  const etag = cardEtag(card);
  const headers = {
    'content-type': 'application/json',
    'cache-control': 'public, max-age=300',
    etag,
  };
  if (req.headers.get('if-none-match') === etag)
    return new Response(null, { status: 304, headers });
  return new Response(JSON.stringify(AgentCard.toJSON(card)), {
    status: 200,
    headers,
  });
}

// The card's public signing keys, unauthenticated like the card; 404 when
// the card is unsigned.
async function serveJwks(
  req: Request,
  port: BridgePort,
  options: HandleOptions
): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD')
    return new Response(null, { status: 405 });
  const wait = options.limiter.allowCard(options.clientIp);
  if (wait !== null) return rateLimited(wait);
  const jwks = (await port.card()).jwks;
  if (jwks === undefined) return new Response('not found', { status: 404 });
  return new Response(req.method === 'HEAD' ? null : JSON.stringify(jwks), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=300',
    },
  });
}

// Everything after authentication, as one response (errors included), so a
// signed caller's response can be signed whatever it carries.
async function serveAuthenticated(
  auth: Authenticated,
  route: Route,
  url: URL,
  port: BridgePort,
  options: HandleOptions
): Promise<Response> {
  try {
    const admitted = await port.admit(auth.caller, 'request');
    if (!admitted.ok) return rateLimited(admitted.retryAfterSec);
    const op: Op = {
      req: auth.req,
      url,
      port,
      options,
      caller: auth.caller,
      stillAllowed: auth.stillAllowed,
    };
    switch (route.op) {
      case 'send':
        return await send(op, false);
      case 'stream':
        return await send(op, true);
      case 'subscribe':
        return await subscribe(op, route.id);
      case 'get':
        return await getTask(op, route.id);
      case 'list':
        return await listTasks(op);
      case 'cancel':
        return await cancelTask(op, route.id);
      case 'pushCreate':
      case 'pushList':
      case 'pushGet':
      case 'pushDelete':
        return await push(op, route);
      case 'extendedCard':
        throw new A2AError(
          'UNSUPPORTED_OPERATION',
          'this agent has no extended card'
        );
    }
  } catch (err) {
    return errorResponse(err);
  }
}

// The public statement of this agent's last key change or revocation.
async function serveKeyStatement(
  req: Request,
  port: BridgePort,
  options: HandleOptions
): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD')
    return new Response(null, { status: 405 });
  const wait = options.limiter.allowCard(options.clientIp);
  if (wait !== null) return rateLimited(wait);
  const statement = (await port.keyStatement?.()) ?? null;
  if (statement === null) return new Response('not found', { status: 404 });
  return new Response(req.method === 'HEAD' ? null : statement, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=300',
    },
  });
}

// The HTTP+JSON binding of A2A 1.0 over a BridgePort: version, then auth,
// then the port's per-client admission, then the operation.
export async function handleA2A(
  req: Request,
  port: BridgePort,
  options: HandleOptions
): Promise<Response> {
  const url = new URL(req.url);
  try {
    if (url.pathname === CARD_PATH) return await serveCard(req, port, options);
    if (url.pathname === JWKS_PATH) return await serveJwks(req, port, options);
    if (url.pathname === KEY_STATEMENT_PATH)
      return await serveKeyStatement(req, port, options);
    if (!url.pathname.startsWith(`${options.basePath}/`))
      return new Response('not found', { status: 404 });
    if (req.method === 'OPTIONS') return new Response(null, { status: 405 });
    // Dispatch extension routes: each authenticates its own body,
    // signature or bearer.
    const ext = EXTENSION.exec(url.pathname.slice(options.basePath.length));
    if (
      req.method === 'POST' &&
      url.pathname.startsWith(options.basePath) &&
      ext !== null
    ) {
      // Rate-limited like the card; any refusal (outside 2xx: an upgrade
      // request's 202 is a success) counts toward the lockout, since each
      // route checks a proof, signature or bearer.
      const wait = options.limiter.allowCard(options.clientIp);
      if (wait !== null) return rateLimited(wait);
      if (port.extension === undefined)
        return new Response('not found', { status: 404 });
      const res = await port.extension(ext[1] as ExtensionRoute, req);
      if (res.status < 200 || res.status >= 300)
        options.limiter.authFailed(options.clientIp);
      return res;
    }
    const route = matchRoute(
      req.method,
      url.pathname.slice(options.basePath.length)
    );
    if (route === null) return new Response('not found', { status: 404 });
    checkVersion(req, url);
    const auth = await authenticate(req, url, port, options);
    if (auth instanceof Response) return auth;
    const res = await serveAuthenticated(auth, route, url, port, options);
    if (!auth.signed || port.signResponse === undefined) return res;
    return await port.signResponse(res, auth.req, auth.caller);
  } catch (err) {
    return errorResponse(err);
  }
}
