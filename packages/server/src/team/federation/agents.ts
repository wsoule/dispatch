import { speaksForHandle } from '@dispatch/federation';
import { isFederationLocalAddress, parseAddress } from '@dispatch/protocol';
import type { AgentRecord, MessageStore } from '@dispatch/protocol';
import { canonicalize, hlcWallMs } from '@dispatch/protocol/federation';
import type { AgentBody, FederatedOp } from '@dispatch/protocol/federation';
import { createHash } from 'node:crypto';

import type { RosterService } from './roster.js';
import type { Collector, OpHandler, StageContext } from './service.js';
import type { FedStore } from './store.js';
import { agentBody, dropNote } from './validate.js';

/** The token hash a replicated agent row carries: no token ever matches it. */
const REMOTE_TOKEN_PREFIX = 'remote:';

interface FedAgentRow {
  address: string;
  replica: string;
  display_name: string;
  client: string;
  status: AgentRecord['status'];
  hlc: string;
}

// The agent roster across daemons: this machine's registrations go out as
// `agent` ops (never a token hash), teammates' come in as rows no local token
// can match, and a revoked replica's agents read revoked here.
export class AgentSync implements Collector, OpHandler {
  readonly order = 2;
  readonly type = 'agent';

  constructor(
    private readonly deps: {
      fed: FedStore;
      roster: RosterService;
      messages: MessageStore;
    }
  ) {}

  /** Publishes each local agent row that differs from what went out last. */
  collect(): void {
    const { fed, roster, messages } = this.deps;
    // FW-R31(4): nothing goes to a team this machine is not firmly in.
    if (fed.head() === null || !roster.mailReady()) return;
    // FW-R33(4): agents an older build's caps refused go out once more.
    if (fed.meta('agents_republished') === null) {
      fed.db.query("DELETE FROM fed_published WHERE kind = 'agent'").run();
      fed.setMeta('agents_republished', '1');
    }
    for (const a of messages.agents()) {
      if (a.tokenHash.startsWith(REMOTE_TOKEN_PREFIX)) continue;
      if (isFederationLocalAddress(a.address)) continue;
      if (!this.ownOperator(a.address)) continue;
      const body: AgentBody = {
        address: a.address,
        displayName: a.displayName,
        client: a.client,
        status: a.status,
      };
      const hash = createHash('sha256')
        .update(canonicalize(body))
        .digest('hex');
      const sent = fed.db
        .query<{ hash: string }, [string]>(
          "SELECT hash FROM fed_published WHERE kind = 'agent' AND ref = ?"
        )
        .get(a.address);
      if (sent?.hash === hash) continue;
      fed.append({
        type: 'agent',
        body: { ...body },
        onStamp: () => {
          fed.db
            .query(
              "INSERT OR REPLACE INTO fed_published (kind, ref, hash) VALUES ('agent', ?, ?)"
            )
            .run(a.address, hash);
        },
      });
    }
  }

  stage(op: FederatedOp, ctx: StageContext): 'applied' | 'parked' | 'dropped' {
    const { fed, messages } = this.deps;
    // FW-R32(3): every field of the grammar, or a malformed note.
    const body = agentBody(op.body);
    if (body === null) {
      dropNote(
        fed,
        'malformed',
        op.replica,
        `${this.deps.roster.label(op.replica)}'s agent op at seq ${op.seq} is not a valid agent; it was dropped`
      );
      return 'dropped';
    }
    const { address } = body;
    const refuse = (message: string, speaksFor = false) => {
      fed.problem(`agent:${address}`, message);
      if (speaksFor)
        fed.audit('speaks-for', `op:${op.replica}:${op.seq}`, {
          replica: op.replica,
          seq: op.seq,
          address,
        });
      return 'dropped' as const;
    };
    const operator = operatorOf(address);
    if (operator === null)
      return refuse(
        `${op.replica} published ${address}, which names no operator`
      );
    if (isFederationLocalAddress(address))
      return refuse(
        `${op.replica} published ${address}, which never leaves its machine; it was dropped`
      );
    if (!speaksForHandle(ctx.view, op.replica, operator, op.seq))
      return refuse(
        `${op.replica} published ${address}, but cannot speak for ${operator}`,
        true
      );
    const local = messages.getAgent(address);
    if (local !== null && !local.tokenHash.startsWith(REMOTE_TOKEN_PREFIX))
      return refuse(
        `${address} is registered on this machine and on ${this.deps.roster.label(op.replica)}'s; the registration here stands`
      );
    const held = this.row(address);
    if (held !== null && held.hlc >= op.hlc) return 'applied';
    fed.db
      .query(
        'INSERT OR REPLACE INTO fed_agents (address, replica, display_name, client, status, hlc) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        address,
        op.replica,
        body.displayName,
        body.client,
        body.status,
        op.hlc
      );
    this.project(ctx.view.revoked);
    return 'applied';
  }

  /** After a pass: each remote agent row follows its publisher's standing,
   *  revoked while the fold revokes it and back once a revocation is voided. */
  passComplete(): void {
    const view = this.deps.roster.view();
    if (view !== null) this.project(view.revoked);
  }

  private project(revoked: ReadonlyMap<string, unknown>): void {
    const { fed, messages } = this.deps;
    for (const row of fed.db
      .query<FedAgentRow, []>('SELECT * FROM fed_agents')
      .all()) {
      const local = messages.getAgent(row.address);
      if (local !== null && !local.tokenHash.startsWith(REMOTE_TOKEN_PREFIX))
        continue;
      const status = revoked.has(row.replica) ? 'revoked' : row.status;
      if (
        local?.status === status &&
        local.displayName === row.display_name &&
        local.client === row.client
      )
        continue;
      messages.putAgent({
        address: row.address,
        displayName: row.display_name,
        client: row.client,
        tokenHash: `${REMOTE_TOKEN_PREFIX}${row.address}`,
        status,
        muted: local?.muted ?? false,
        approvedBy: local?.approvedBy ?? null,
        createdAt:
          local?.createdAt ?? new Date(hlcWallMs(row.hlc) ?? 0).toISOString(),
      });
    }
  }

  // Only agents of a handle this machine speaks for go out.
  private ownOperator(address: string): boolean {
    const operator = operatorOf(address);
    const me = this.deps.roster.view()?.members.get(this.deps.fed.replica);
    return (
      operator !== null &&
      me !== undefined &&
      (me.handle === operator || me.hosts.includes(operator))
    );
  }

  private row(address: string): FedAgentRow | null {
    return this.deps.fed.db
      .query<FedAgentRow, [string]>(
        'SELECT * FROM fed_agents WHERE address = ?'
      )
      .get(address);
  }
}

// The operator handle of `agent:<op>/<name>`, or null.
function operatorOf(address: string): string | null {
  try {
    const p = parseAddress(address, 'address');
    return p.kind === 'agent' ? p.operator : null;
  } catch {
    return null;
  }
}
