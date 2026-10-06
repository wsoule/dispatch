import type { FederatedOp } from '@dispatch-foo/protocol/federation';

import type { RosterService } from './roster.js';
import type { OpHandler } from './service.js';
import type { FedStore } from './store.js';

// An a2a op belongs only on a teammate link's own branch (A2A P5). On the
// team log it is dropped, never parked: one rolling note per publisher and
// one audit row per publisher a daemon run, so a flood fills no table.
export class LinkOpsOffTeamLog implements OpHandler {
  readonly type = 'a2a';
  private readonly audited = new Set<string>();

  constructor(
    private readonly deps: {
      fed: FedStore;
      roster: Pick<RosterService, 'label'>;
    }
  ) {}

  stage(op: FederatedOp): 'dropped' {
    const { fed, roster } = this.deps;
    fed.problem(
      `link-op:${op.replica}`,
      `${roster.label(op.replica)} put a teammate-link (a2a) op on the team sync branch, latest at seq ${op.seq}; link ops travel only on a link's own branch, so it was dropped. Acknowledge this, or ask them to update Dispatch.`
    );
    if (!this.audited.has(op.replica)) {
      this.audited.add(op.replica);
      fed.audit('link-op', `op:${op.replica}:${op.seq}`, {
        replica: op.replica,
        seq: op.seq,
      });
    }
    return 'dropped';
  }
}
