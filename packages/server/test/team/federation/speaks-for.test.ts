import { afterEach, describe, expect, it } from 'bun:test';

import type { Evidence } from '../../../src/team/federation/service.js';
import { speaksFor } from '../../../src/team/federation/speaksFor.js';
import { foundedTeam } from './helpers/messagingReplica.js';
import type { MessagingReplica } from './helpers/messagingReplica.js';

let open: MessagingReplica[] = [];
afterEach(() => {
  for (const r of open) r.close();
  open = [];
});
const at = (i: number): MessagingReplica => open[i];
const none = (): Evidence => ({ runs: new Map(), agents: new Map() });

function check(
  r: MessagingReplica,
  replica: string,
  from: string,
  evidence = none(),
  extra: { kind?: 'message' | 'notice'; data?: Record<string, string> } = {}
) {
  const view = r.roster.view();
  if (view === null) throw new Error('no roster');
  return speaksFor({
    replica,
    message: { from, kind: extra.kind ?? 'message', data: extra.data },
    seq: 100,
    view,
    fed: r.fed,
    evidence,
  });
}

describe('speaks for', () => {
  it('lets a replica speak for its own human, never another', async () => {
    open = await foundedTeam('ada', 'bob');
    expect(check(at(0), at(1).fed.replica, 'human:bob')).toBe(true);
    expect(check(at(0), at(1).fed.replica, 'human:ada')).toBe(false);
  });

  it("speaks for a run once its presence binds it, and waits while it hasn't arrived", async () => {
    open = await foundedTeam('ada', 'bob');
    const bob = at(1).fed.replica;
    expect(check(at(0), bob, 'run:r-0000000000aa')).toBeNull();
    const pull = none();
    pull.runs.set('r-0000000000aa', [bob]);
    expect(check(at(0), bob, 'run:r-0000000000aa', pull)).toBe(true);
    at(1).startRun({ id: 'r-0000000000aa', taskId: null, kind: 'review' });
    await at(0).settleWith(at(1));
    expect(check(at(0), bob, 'run:r-0000000000aa')).toBe(true);
    expect(check(at(0), at(0).fed.replica, 'run:r-0000000000aa')).toBe(false);
  });

  it('speaks for the system only on a plain notice', async () => {
    open = await foundedTeam('ada', 'bob');
    const bob = at(1).fed.replica;
    expect(
      check(at(0), bob, 'agent:dispatch', none(), { kind: 'notice' })
    ).toBe(true);
    expect(check(at(0), bob, 'agent:dispatch')).toBe(false);
    expect(
      check(at(0), bob, 'agent:dispatch', none(), {
        kind: 'notice',
        data: { type: 'x-policy' },
      })
    ).toBe(false);
  });
});
