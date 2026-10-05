import {
  A2A_VERSION_HEADER,
  AgentCard,
  GetTaskRequest,
  HTTP_EXTENSION_HEADER,
  Message,
  SendMessageRequest,
  SubscribeToTaskRequest,
  Task,
} from '@a2a-js/sdk';
import type { Client } from '@a2a-js/sdk/client';
import { VersionNotSupportedError } from '@a2a-js/sdk/errors';
import type { JsonValue } from '@dispatch/protocol';
import type { KeyObject } from 'node:crypto';

import { signedFetch } from '../sig/fetch.js';
import { ENVELOPE_URI, WORK_URI } from '../uris.js';
import type { MessageJson, TaskJson } from '../wire.js';
import type { PeerInterface } from './card.js';
import type { GuardOptions } from './guard.js';
import { peerFetch, PeerHttpError } from './http.js';
import type { StatusBox } from './http.js';
import { PEER_OUTPUT_MODES } from './message.js';

export type PeerSendResult =
  | { kind: 'task'; task: TaskJson }
  | { kind: 'message'; message: MessageJson };

export interface PeerClientOptions {
  iface: PeerInterface;
  card: Record<string, JsonValue>;
  headers: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  // A decide-tier peer: every request re-resolves, refuses non-public
  // addresses and connects to the checked one.
  guard?: GuardOptions;
  // A paired peer (P5): requests are signed with this project's card key and
  // only responses its pinned key signed are read.
  signed?: { keyid: string; privateKey: KeyObject; peerKey: KeyObject };
}

// The SDK reads a peer's "version not supported" as one of two error classes,
// by binding; both carry the A2A reason in their name.
function versionNotSupported(err: unknown): boolean {
  return (
    err instanceof VersionNotSupportedError ||
    (err instanceof Error && /VersionNotSupported/.test(err.name))
  );
}

const MAX_MESSAGE_CHARS = 300;

// A peer-supplied error text as one short line: control characters become
// spaces and the rest is cut, since an SDK error can carry the whole body.
function shortMessage(text: string): string {
  let out = '';
  for (const ch of text.slice(0, MAX_MESSAGE_CHARS * 2)) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || (code >= 0x7f && code < 0xa0) ? ' ' : ch;
  }
  out = out.replace(/ {2,}/g, ' ').trim();
  return out.length > MAX_MESSAGE_CHARS
    ? `${out.slice(0, MAX_MESSAGE_CHARS - 1)}…`
    : out;
}

// The daemon's client for one peer: the SDK client pinned to the checked
// interface, the peer's auth header, A2A-Version 1.0, no redirects, and a 30 s
// headers timeout. Every failure surfaces as a PeerHttpError.
export class PeerClient {
  constructor(private readonly o: PeerClientOptions) {}

  private async sdk(box: StatusBox, signal?: AbortSignal): Promise<Client> {
    // Loaded on first contact, not at import: see test/lazy-imports.test.ts.
    const { ClientFactory, JsonRpcTransportFactory, RestTransportFactory } =
      await import('@a2a-js/sdk/client');
    const plainFetch = peerFetch({
      headers: {
        [A2A_VERSION_HEADER]: '1.0',
        [HTTP_EXTENSION_HEADER]: `${ENVELOPE_URI}, ${WORK_URI}`,
        ...this.o.headers,
      },
      fetchImpl: this.o.fetchImpl,
      timeoutMs: this.o.timeoutMs ?? 30_000,
      signal,
      box,
      guard:
        this.o.guard === undefined
          ? undefined
          : { field: 'url', ...this.o.guard },
    });
    const fetchImpl =
      this.o.signed === undefined
        ? plainFetch
        : signedFetch(plainFetch, { ...this.o.signed, box });
    const transport =
      this.o.iface.binding === 'HTTP+JSON'
        ? new RestTransportFactory({ fetchImpl })
        : new JsonRpcTransportFactory({ fetchImpl });
    const card = AgentCard.fromJSON({
      ...this.o.card,
      supportedInterfaces: [
        {
          url: this.o.iface.url,
          protocolBinding: this.o.iface.binding,
          protocolVersion: '1.0',
        },
      ],
    });
    return new ClientFactory({ transports: [transport] }).createFromAgentCard(
      card
    );
  }

  // Network errors stay retryable (status null); an A2A error the SDK read from
  // the body is final (its HTTP status, or 400 for a JSON-RPC error in a 200).
  private async call<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const box: StatusBox = {
      status: null,
      retryAfterSec: null,
      network: false,
    };
    try {
      return await fn(await this.sdk(box));
    } catch (err) {
      if (err instanceof PeerHttpError) throw err;
      const raw = err instanceof Error ? err.message : String(err);
      if (box.network) throw new PeerHttpError(null, shortMessage(raw));
      const status =
        box.status !== null && box.status >= 400 ? box.status : 400;
      // The worker acts on VERSION_NOT_SUPPORTED (a card refresh) and AUTH_* (a failed credential).
      const reason = versionNotSupported(err)
        ? 'VERSION_NOT_SUPPORTED'
        : (box.reason ?? null);
      throw new PeerHttpError(
        status,
        `the peer answered HTTP ${status}`,
        box.retryAfterSec,
        reason,
        shortMessage(raw)
      );
    }
  }

  async send(message: MessageJson): Promise<PeerSendResult> {
    const request = SendMessageRequest.fromJSON({
      message,
      configuration: {
        returnImmediately: true,
        acceptedOutputModes: [...PEER_OUTPUT_MODES],
      },
    });
    const result = await this.call((c) => c.sendMessage(request));
    return 'status' in result
      ? { kind: 'task', task: Task.toJSON(result) as TaskJson }
      : {
          kind: 'message',
          message: Message.toJSON(result) as MessageJson,
        };
  }

  async getTask(taskId: string): Promise<TaskJson> {
    const task = await this.call((c) =>
      c.getTask(GetTaskRequest.fromJSON({ id: taskId }))
    );
    return Task.toJSON(task) as TaskJson;
  }

  // One tick per event the peer streams for a task; ends when the stream does.
  // Any error here means "fall back to polling" to the worker.
  async *changes(taskId: string, signal: AbortSignal): AsyncGenerator<void> {
    const box: StatusBox = {
      status: null,
      retryAfterSec: null,
      network: false,
    };
    const client = await this.sdk(box, signal);
    for await (const _event of client.resubscribeTask(
      SubscribeToTaskRequest.fromJSON({ id: taskId }),
      { signal }
    )) {
      if (signal.aborted) return;
      yield;
    }
  }
}
