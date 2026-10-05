import { handleA2A, IpLimiter, loadOrCreateLinkKeys } from '@dispatch/a2a';
import type {
  A2APolicy,
  A2AStore,
  AuthResult,
  BridgePort,
  Caller,
  LinkPayload,
  PeerRow,
} from '@dispatch/a2a';
import type { AgentRecord } from '@dispatch/protocol';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { runsDir } from '../orchestrator/paths.js';
import { LinkPeerClient } from '../team/links/client.js';
import { LinkHub } from '../team/links/hub.js';
import { authenticateSignedAgent } from './auth.js';
import type { OutboundClient } from './outbound.js';

export interface LinkWiringDeps {
  rootDir: string;
  store: A2AStore;
  messages: { getAgent(address: string): AgentRecord | null };
  port: () => BridgePort | null;
  policy: () => A2APolicy;
  unpaired: (pairedId: string) => void;
  keyChange: (pairedId: string, statement: unknown) => void;
  changed: () => void;
  now?: () => Date;
  intervalMs?: number;
}

const REFUSED: AuthResult = {
  ok: false,
  status: 401,
  reason: 'AUTH_INVALID_TOKEN',
  message: 'unknown token',
};

// The port as the paired client of one link sees it: a one-request token in
// place of a signature, and no extension routes. Everything else is the
// port's own, so every inbound policy applies to link requests unchanged.
function asLinkClient(
  port: BridgePort,
  caller: Caller,
  token: string
): BridgePort {
  const view = Object.create(port) as BridgePort;
  Object.assign(view, {
    authenticate: (bearer: string) =>
      Promise.resolve(bearer === token ? { ok: true, caller } : REFUSED),
    authenticateSigned: undefined,
    signResponse: undefined,
    extension: undefined,
    revalidate: () => Promise.resolve(false),
  });
  return view;
}

// Teammate links in the daemon (T54): the hub once the link keys load, the
// worker's link clients, and the receiver's A2A requests as the paired client.
export class LinkWiring {
  private hub: LinkHub | null = null;
  private readonly limiter = new IpLimiter();

  constructor(private readonly d: LinkWiringDeps) {}

  get links(): LinkHub | null {
    return this.hub;
  }

  /** Loads the link keys and starts the hub; links stay off without them. */
  async start(): Promise<void> {
    if (this.hub !== null) return;
    const keys = await loadOrCreateLinkKeys(this.d.rootDir);
    if (keys === null) return;
    const now = this.d.now ?? (() => new Date());
    this.hub = new LinkHub({
      dir: join(runsDir(this.d.rootDir), 'a2a-links'),
      keys,
      paired: (alias) => this.pairedId(alias) !== null,
      serve: (alias, req) => this.serve(alias, req),
      watch: (alias, taskId, onChange) => {
        const caller = this.callerOf(alias);
        const port = this.d.port();
        if (caller === null || port === null) return () => {};
        return port.watch(caller, taskId, onChange);
      },
      unpaired: (_alias, pairedId) => this.d.unpaired(pairedId),
      keyChange: (alias, statement) => {
        const id = this.pairedId(alias);
        if (id !== null) this.d.keyChange(id, statement);
      },
      now,
      changed: this.d.changed,
      ...(this.d.intervalMs === undefined
        ? {}
        : { intervalMs: this.d.intervalMs }),
    });
    this.hub.start();
  }

  async stop(): Promise<void> {
    const hub = this.hub;
    this.hub = null;
    await hub?.stop();
  }

  clientFor(row: PeerRow): OutboundClient | null {
    if (this.hub === null || this.hub.get(row.alias) === null) return null;
    return new LinkPeerClient(
      this.hub,
      row.alias,
      this.d.now ?? (() => new Date())
    );
  }

  /** Publishes the unpair notice and pushes it; true once on the branch. */
  async unpair(alias: string, pairedId: string): Promise<boolean> {
    const hub = this.hub;
    if (hub === null) return false;
    const r = hub.publish(alias, {
      kind: 'unpair',
      id: pairedId,
      at: (this.d.now?.() ?? new Date()).toISOString(),
    });
    if (r !== 'published') return false;
    await hub.settle();
    return true;
  }

  statement(alias: string, statement: unknown): boolean {
    const r = this.hub?.publish(alias, {
      kind: 'key-change',
      statement,
    } as LinkPayload);
    return r === 'published' || r === 'waiting';
  }

  /** The peer gone for good: the link is forgotten too. */
  removed(alias: string): void {
    this.hub?.remove(alias);
  }

  // The pairing of a link peer still standing (not unpaired), or null.
  private pairedId(alias: string): string | null {
    const peer = this.d.store.getPeer(alias);
    if (peer?.auth !== 'link' || peer.pairedId == null) return null;
    const state = this.d.store.pairing(peer.pairedId)?.state;
    return state === 'unpaired' || state === 'canceled' ? null : peer.pairedId;
  }

  // The paired client of a link, as its pinned key authenticates it now.
  private callerOf(alias: string): Caller | null {
    const id = this.pairedId(alias);
    if (id === null) return null;
    const client = this.d.store.clients().find((c) => c.pairedId === id);
    if (client === undefined) return null;
    const auth = authenticateSignedAgent(
      this.d.messages.getAgent(client.address),
      client.auth ?? null,
      'link'
    );
    return auth.ok ? auth.caller : null;
  }

  private async serve(alias: string, req: Request): Promise<Response> {
    const port = this.d.port();
    const caller = this.callerOf(alias);
    if (port === null || caller === null)
      return Response.json(
        { error: { code: 401, message: 'this pairing no longer stands' } },
        { status: 401 }
      );
    const token = randomUUID();
    const headers = new Headers(req.headers);
    headers.set('authorization', `Bearer ${token}`);
    const body = req.method === 'GET' ? undefined : await req.text();
    return handleA2A(
      new Request(req.url, {
        method: req.method,
        headers,
        ...(body === undefined ? {} : { body }),
      }),
      asLinkClient(port, caller, token),
      {
        basePath: '/a2a/v1',
        policy: this.d.policy(),
        clientIp: null,
        limiter: this.limiter,
      }
    );
  }
}
