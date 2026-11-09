// Outside-user requests: an intake link lets a person with no Dispatch
// account submit a request through a web form, and follow it on a private
// status page. Each submission is an A2A handoff from the A2A client the link
// is bound to, so the owner's approval gate, the draft's untrusted fence, the
// per-client limits and the status projection are the handoff path's own;
// this module only turns a form into a handoff and a decision into a page.
// Spec: the "outside-user requests" doc on task t-020803d2.

import type {
  A2AStore,
  BridgePort,
  Caller,
  Decision,
  IntakeLinkRow,
  IntakeRequestRow,
  IpLimiter,
  TaskFacts,
} from '@dispatch-foo/a2a';
import { decideState, statusAt, TERMINAL_STATES } from '@dispatch-foo/a2a';
import { MessagingError, SYSTEM_ADDRESS } from '@dispatch-foo/protocol';
import type { Address } from '@dispatch-foo/protocol';
import { randomBytes, randomUUID } from 'node:crypto';

import { tokenHash } from './auth.js';
import type { FormView } from './intakePage.js';
import { renderForm, renderStatus, renderUnavailable } from './intakePage.js';

/** Where a request sits, as its requester reads it. */
export type IntakeStep =
  | 'received'
  | 'accepted'
  | 'working'
  | 'question'
  | 'review'
  | 'landing'
  | 'done'
  | 'declined'
  | 'withdrawn'
  | 'closed';

const INTAKE_FORM_PREFIX = '/r/';
const INTAKE_STATUS_PREFIX = '/s/';
const TOKEN = /^[0-9a-f]{64}$/;
const LIMITS = { title: 200, details: 8000, name: 100, contact: 200 };
// How each field is named back to the person filling the form in.
const FIELD_NAMES: Record<keyof typeof LIMITS, string> = {
  title: 'what you need',
  details: 'the details',
  name: 'your name',
  contact: 'how to reach you',
};
const MAX_LABEL = 100;

const PAGE_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  // Nothing loads or runs; forms post only to the page itself.
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  // The URL is the credential: it must not leave in a Referer header.
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: PAGE_HEADERS });
}

function seeOther(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { ...PAGE_HEADERS, location },
  });
}

function retryLater(seconds: number): Response {
  const res = html(
    renderUnavailable('Too many requests from here; try again in a minute.'),
    429
  );
  res.headers.set('retry-after', String(seconds));
  return res;
}

/** A fresh 32-byte token and the sha256 a2a.db keeps in its place. */
function mintToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('hex');
  return { token, hash: tokenHash(token) };
}

/** The caller an intake link acts as: the A2A client it is bound to. */
function callerOf(link: Pick<IntakeLinkRow, 'client'>): Caller {
  return {
    address: link.client,
    name: link.client.slice(link.client.indexOf('/') + 1),
  };
}

/** Replaces any path that carries a token with its prefix, for access logs. */
export function redactIntakePath(pathname: string): string {
  if (pathname.startsWith(INTAKE_FORM_PREFIX)) return `${INTAKE_FORM_PREFIX}…`;
  if (pathname.startsWith(INTAKE_STATUS_PREFIX))
    return `${INTAKE_STATUS_PREFIX}…`;
  return pathname;
}

export function isIntakePath(pathname: string): boolean {
  return (
    pathname.startsWith(INTAKE_FORM_PREFIX) ||
    pathname.startsWith(INTAKE_STATUS_PREFIX)
  );
}

/**
 * Mints an intake link for an approved A2A client. The token is returned once
 * and kept only as its hash; the caller builds the URL from the listener's
 * public URL.
 */
export function mintIntakeLink(
  store: A2AStore,
  clientStatus: (address: Address) => string | null,
  input: { client: Address; label: string; createdBy: Address; now?: Date }
): { row: IntakeLinkRow; token: string } {
  if (store.getClient(input.client) === null)
    throw new MessagingError(
      'not-found',
      `no A2A client ${input.client}`,
      'client'
    );
  if (clientStatus(input.client) !== 'approved')
    throw new MessagingError(
      'invalid',
      `${input.client} is not approved; approve it before giving it an intake link`,
      'client'
    );
  const label = input.label.trim().replace(/\s+/g, ' ');
  if (label === '' || label.length > MAX_LABEL)
    throw new MessagingError(
      'invalid',
      `label must be 1 to ${MAX_LABEL} characters`,
      'label'
    );
  const { token, hash } = mintToken();
  const row: IntakeLinkRow = {
    id: `in-${randomBytes(4).toString('hex')}`,
    client: input.client,
    label,
    tokenHash: hash,
    createdBy: input.createdBy,
    createdAt: (input.now ?? new Date()).toISOString(),
    revokedAt: null,
  };
  store.putIntakeLink(row);
  return { row, token };
}

/** The listener-relative URL a link's form lives at. */
export function intakeFormUrl(publicUrl: string, token: string): string {
  return `${publicUrl.replace(/\/$/, '')}${INTAKE_FORM_PREFIX}${token}`;
}

// The team's latest message, never the system's own markers ("Accepted as
// t-…" names the task id, which the page does not show).
function teamMessage(d: Decision): string | null {
  if (d.status.kind !== 'message') return null;
  const m = d.status.message;
  if (m.from === SYSTEM_ADDRESS || m.body.trim() === '') return null;
  return m.body;
}

/**
 * The requester's view of one A2A decision: which step it is and the sentence
 * the page leads with. Read only from the decision and the linked task's
 * approval, so the page and the webhook can never disagree with A2A clients.
 */
function intakeStep(
  facts: TaskFacts,
  d: Decision
): { step: IntakeStep; headline: string } {
  switch (d.state) {
    case 'COMPLETED':
      return { step: 'done', headline: 'Done: the change has landed.' };
    case 'REJECTED':
      return { step: 'declined', headline: 'The team declined this request.' };
    case 'CANCELED':
      return { step: 'withdrawn', headline: 'This request was withdrawn.' };
    case 'FAILED':
      return { step: 'closed', headline: 'This request was closed.' };
    case 'INPUT_REQUIRED':
      return {
        step: 'question',
        headline: 'The team has a question for you.',
      };
    case 'AUTH_REQUIRED': {
      const task = facts.task;
      const approved = task !== null && task !== 'deleted' && task.approved;
      return approved
        ? { step: 'working', headline: 'In progress: waiting on the team.' }
        : {
            step: 'received',
            headline: 'Received: waiting for the team to accept it.',
          };
    }
    case 'SUBMITTED':
      return { step: 'accepted', headline: 'Accepted: queued for work.' };
    case 'WORKING':
      if (d.stage === 'review')
        return { step: 'review', headline: 'In review.' };
      if (d.stage === 'landing')
        return { step: 'landing', headline: 'Approved: landing now.' };
      return { step: 'working', headline: 'In progress.' };
  }
}

// Only a web URL is a link on the page; anything else is left off.
function webUrl(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

// One form field: trimmed, within its limit, and one line unless `multi`.
function field(
  form: URLSearchParams,
  key: keyof typeof LIMITS,
  opts: { required: boolean; multi?: boolean }
): { ok: true; value: string } | { ok: false; error: string } {
  const raw = form.get(key);
  const value =
    raw !== null
      ? opts.multi === true
        ? raw.replace(/\r\n/g, '\n').trim()
        : raw.replace(/\s+/g, ' ').trim()
      : '';
  if (opts.required && value === '')
    return { ok: false, error: `Please fill in ${FIELD_NAMES[key]}.` };
  if (value.length > LIMITS[key])
    return {
      ok: false,
      error: `Please shorten ${FIELD_NAMES[key]} to at most ${LIMITS[key]} characters.`,
    };
  return { ok: true, value };
}

/** A posted form, urlencoded as the pages send it; null for any other body,
 *  so a multipart upload is refused rather than parsed. */
async function readForm(req: Request): Promise<URLSearchParams | null> {
  const type = req.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/x-www-form-urlencoded'))
    return null;
  try {
    return new URLSearchParams(await req.text());
  } catch {
    return null;
  }
}

/** What a request becomes in the draft: who sent it, then what they wrote.
 *  shapeDraft fences all of it as untrusted text. */
export function requestBody(input: {
  name: string;
  contact: string;
  details: string;
}): string {
  const from =
    input.contact === ''
      ? `From: ${input.name}`
      : `From: ${input.name} (${input.contact})`;
  const via = 'Sent through an intake link; name and contact are unverified.';
  return input.details === ''
    ? `${from}\n${via}`
    : `${from}\n${via}\n\n${input.details}`;
}

export interface IntakeDeps {
  store: A2AStore;
  port: BridgePort;
  // The agent row's status for an A2A client: 'approved', 'pending', 'revoked'.
  clientStatus: (address: Address) => string | null;
  limiter: IpLimiter;
  // Called once a submission's request row exists, with its status URL path
  // (so the first webhook can carry it) and its facts.
  submitted?: (
    request: IntakeRequestRow,
    statusPath: string,
    facts: TaskFacts
  ) => void;
  now?: () => Date;
}

/**
 * The form and status pages, served on the A2A listener under /r/<token> and
 * /s/<token>. Unknown tokens count as auth failures toward the listener's IP
 * lockout, and every page view takes a slot of its per-IP rate, so a token
 * cannot be guessed at speed.
 */
export class IntakePages {
  constructor(private readonly deps: IntakeDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async handle(req: Request, clientIp: string | null): Promise<Response> {
    const { pathname } = new URL(req.url);
    const locked = this.deps.limiter.lockedFor(clientIp);
    if (locked !== null) return retryLater(locked);
    const wait = this.deps.limiter.allowCard(clientIp);
    if (wait !== null) return retryLater(wait);
    const form = pathname.startsWith(INTAKE_FORM_PREFIX);
    const token = pathname.slice(
      (form ? INTAKE_FORM_PREFIX : INTAKE_STATUS_PREFIX).length
    );
    if (req.method !== 'GET' && req.method !== 'POST')
      return html(renderUnavailable(), 405);
    if (!TOKEN.test(token)) return this.unknown(clientIp);
    return form
      ? this.formRoute(req, token, clientIp)
      : this.statusRoute(req, token, clientIp);
  }

  private unknown(clientIp: string | null): Response {
    this.deps.limiter.authFailed(clientIp);
    return html(renderUnavailable(), 404);
  }

  // A live link whose client may still submit; null answers as unknown.
  private liveLink(token: string): IntakeLinkRow | null {
    const link = this.deps.store.intakeLinkByTokenHash(tokenHash(token));
    if (link === null || link.revokedAt !== null) return null;
    return this.deps.clientStatus(link.client) === 'approved' ? link : null;
  }

  private async formRoute(
    req: Request,
    token: string,
    clientIp: string | null
  ): Promise<Response> {
    const link = this.liveLink(token);
    if (link === null) return this.unknown(clientIp);
    if (req.method === 'GET') return html(renderForm({ label: link.label }));
    const form = await readForm(req);
    if (form === null)
      return html(
        renderForm({
          label: link.label,
          error: 'That form could not be read.',
        }),
        400
      );
    const title = field(form, 'title', { required: true });
    const details = field(form, 'details', { required: false, multi: true });
    const name = field(form, 'name', { required: true });
    const contact = field(form, 'contact', { required: false });
    const values: FormView['values'] = {
      title: title.ok ? title.value : '',
      details: details.ok ? details.value : '',
      name: name.ok ? name.value : '',
      contact: contact.ok ? contact.value : '',
    };
    const bad = [title, details, name, contact].find((f) => !f.ok);
    if (bad !== undefined && !bad.ok)
      return html(
        renderForm({ label: link.label, values, error: bad.error }),
        400
      );
    if (!title.ok || !details.ok || !name.ok || !contact.ok)
      return html(renderUnavailable(), 400);
    const caller = callerOf(link);
    const admitted = await this.deps.port.admit(caller, 'request');
    if (!admitted.ok) return retryLater(admitted.retryAfterSec);
    let taskId: string;
    try {
      const opened = await this.deps.port.open(caller, {
        clientMessageId: randomUUID(),
        contextId: null,
        kind: 'handoff',
        to: null,
        replyTo: null,
        body: requestBody({
          name: name.value,
          contact: contact.value,
          details: details.value,
        }),
        refs: [],
        work: { skill: 'handoff', title: title.value },
      });
      if (opened.kind !== 'task') return html(renderUnavailable(), 500);
      taskId = opened.taskId;
    } catch (err) {
      if (err instanceof MessagingError && err.code === 'limited')
        return html(
          renderForm({
            label: link.label,
            values,
            error:
              'This form is taking no more requests today. Please try again tomorrow.',
          }),
          429
        );
      if (err instanceof MessagingError && err.code === 'invalid')
        return html(
          renderForm({
            label: link.label,
            values,
            error:
              err.field === 'work.skill'
                ? 'The team is not taking requests right now.'
                : `The request could not be sent: ${err.message}`,
          }),
          400
        );
      throw err;
    } finally {
      admitted.release?.();
    }
    const status = mintToken();
    const row: IntakeRequestRow = {
      id: `rq-${randomBytes(6).toString('hex')}`,
      linkId: link.id,
      taskId,
      statusHash: status.hash,
      name: name.value,
      contact: contact.value === '' ? null : contact.value,
      notifiedStep: null,
      createdAt: this.now().toISOString(),
    };
    this.deps.store.putIntakeRequest(row);
    const statusPath = `${INTAKE_STATUS_PREFIX}${status.token}`;
    // The draft and gate were made before this row, so the watch's first
    // recompute found no request to notify about: the first step is told here.
    const facts = await this.deps.port.facts(caller, taskId);
    if (facts !== null) this.deps.submitted?.(row, statusPath, facts);
    // Relative, so a proxy mounting the listener under a path keeps working.
    return seeOther(`../s/${status.token}`);
  }

  private async statusRoute(
    req: Request,
    token: string,
    clientIp: string | null
  ): Promise<Response> {
    const request = this.deps.store.intakeRequestByStatusHash(tokenHash(token));
    const link =
      request === null ? null : this.deps.store.intakeLink(request.linkId);
    if (request === null || link === null) return this.unknown(clientIp);
    // A revoked link takes no new requests, but its requests stay readable.
    const caller = callerOf(link);
    const facts = await this.deps.port.facts(caller, request.taskId);
    if (facts === null)
      return html(
        renderUnavailable('This request is no longer available.'),
        404
      );
    const decision = decideState(facts);
    if (req.method === 'POST')
      return this.reply(req, token, caller, facts, decision);
    return html(renderStatus(statusView(facts, decision)));
  }

  // An answer to the team's open question; anything else is refused, so the
  // status page is not a free channel into the project.
  private async reply(
    req: Request,
    token: string,
    caller: Caller,
    facts: TaskFacts,
    decision: Decision
  ): Promise<Response> {
    const view = statusView(facts, decision);
    if (decision.state !== 'INPUT_REQUIRED')
      return html(
        renderStatus({ ...view, error: 'There is no question to answer now.' }),
        409
      );
    const form = await readForm(req);
    if (form === null)
      return html(
        renderStatus({ ...view, error: 'That answer could not be read.' }),
        400
      );
    const body = (form.get('body') ?? '').replace(/\r\n/g, '\n').trim();
    const rawChoice = form.get('choice');
    const choice =
      rawChoice !== null && rawChoice !== '' ? rawChoice : undefined;
    if (body.length > LIMITS.details)
      return html(
        renderStatus({ ...view, error: 'That answer is too long.' }),
        400
      );
    if (body === '' && choice === undefined)
      return html(
        renderStatus({ ...view, error: 'Please write an answer.' }),
        400
      );
    const admitted = await this.deps.port.admit(caller, 'request');
    if (!admitted.ok) return retryLater(admitted.retryAfterSec);
    try {
      const result = await this.deps.port.continue(caller, {
        clientMessageId: randomUUID(),
        taskId: facts.id,
        contextId: null,
        body: body === '' ? (choice ?? '') : body,
        refs: [],
        ...(choice === undefined ? {} : { choice }),
      });
      if (result.reask !== null)
        return html(renderStatus({ ...view, error: result.reask }), 400);
    } finally {
      admitted.release?.();
    }
    return seeOther(token);
  }
}

/** The status page's data for one decision. */
function statusView(
  facts: TaskFacts,
  decision: Decision
): Parameters<typeof renderStatus>[0] {
  const { step, headline } = intakeStep(facts, decision);
  const task = facts.task;
  const title =
    task !== null && task !== 'deleted' ? task.title : 'Your request';
  const question =
    decision.state === 'INPUT_REQUIRED' && decision.status.kind === 'message'
      ? { choices: [...(decision.status.message.choices ?? [])] }
      : null;
  const pr = facts.work.pr;
  return {
    title,
    step,
    headline,
    message: teamMessage(decision),
    question,
    prUrl: pr?.kind === 'pr' ? webUrl(pr.url) : null,
    updatedAt: statusAt(facts, decision),
    terminal: TERMINAL_STATES.has(decision.state),
  };
}

/** The JSON body a `request.changed` webhook POST carries. */
export interface IntakeWebhookPayload {
  event: 'request.changed';
  sentAt: string;
  project: { rootDir: string };
  request: {
    id: string;
    link: string;
    linkLabel: string;
    // The Dispatch task the request became; null until its draft exists.
    task: string | null;
    title: string;
    step: IntakeStep;
    headline: string;
    name: string;
    contact: string | null;
    // Only on the first event, while the token is still in hand; later
    // events correlate by `id`.
    statusUrl?: string;
  };
}

export interface IntakeNotifierDeps {
  rootDir: string;
  store: A2AStore;
  // The notifications.webhook URL, read per event so a config edit applies live.
  webhook: () => string | undefined;
  // The listener's public URL, for the status link on the first event.
  publicUrl: () => string | null;
  fetch?: typeof globalThis.fetch;
  log?: (line: string) => void;
  now?: () => Date;
  timeoutMs?: number;
}

/**
 * Posts `request.changed` to the owner's notifications webhook each time a
 * request's step changes: the seam through which an owner's own automation
 * emails the requester. At most once per step: the step is recorded before
 * the POST, and a failed POST is logged, not retried, as for decision.opened.
 */
export class IntakeNotifier {
  constructor(private readonly deps: IntakeNotifierDeps) {}

  /** Checks one A2A task; a task no intake request owns is ignored. */
  changed(
    taskId: string,
    facts: TaskFacts,
    statusPath?: string
  ): Promise<void> {
    const request = this.deps.store.intakeRequestForTask(taskId);
    if (request === null) return Promise.resolve();
    const decision = decideState(facts);
    const { step, headline } = intakeStep(facts, decision);
    if (request.notifiedStep === step) return Promise.resolve();
    this.deps.store.setIntakeNotified(request.id, step);
    const url = this.readWebhook();
    if (url === undefined) return Promise.resolve();
    const link = this.deps.store.intakeLink(request.linkId);
    const task = facts.task;
    const base = this.deps.publicUrl();
    const payload: IntakeWebhookPayload = {
      event: 'request.changed',
      sentAt: (this.deps.now?.() ?? new Date()).toISOString(),
      project: { rootDir: this.deps.rootDir },
      request: {
        id: request.id,
        link: request.linkId,
        linkLabel: link?.label ?? '',
        task: task !== null && task !== 'deleted' ? task.id : null,
        title:
          task !== null && task !== 'deleted' ? task.title : 'Your request',
        step,
        headline,
        name: request.name,
        contact: request.contact,
        ...(statusPath === undefined || base === null
          ? {}
          : { statusUrl: `${base.replace(/\/$/, '')}${statusPath}` }),
      },
    };
    return this.post(url, payload);
  }

  private readWebhook(): string | undefined {
    try {
      return this.deps.webhook();
    } catch (err) {
      this.log(
        `dispatchd: request.changed skipped, could not read notifications config: ${(err as Error).message}`
      );
      return undefined;
    }
  }

  private log(line: string): void {
    (this.deps.log ?? ((l: string) => console.warn(l)))(line);
  }

  // One POST, never throwing; the request id is logged, never its contact.
  private async post(
    url: string,
    payload: IntakeWebhookPayload
  ): Promise<void> {
    const label = `request.changed ${payload.request.id}`;
    try {
      const res = await (this.deps.fetch ?? globalThis.fetch)(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'dispatchd',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? 10_000),
      });
      if (!res.ok)
        this.log(
          `dispatchd: webhook delivery of ${label} failed: HTTP ${res.status}`
        );
    } catch (err) {
      this.log(
        `dispatchd: webhook delivery of ${label} failed: ${(err as Error).message}`
      );
    }
  }
}
