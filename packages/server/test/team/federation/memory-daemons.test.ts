import { afterEach, describe, expect, it } from 'bun:test';

import { cluster, quiesce } from './harness/cluster.js';
import type { Member } from './harness/cluster.js';

// T20 between real daemons: index.ts wires memory.db to signed memory ops.
const SLOW = 180_000;
let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
  await stop?.();
  stop = null;
});

describe('team memory between real daemons (F3)', () => {
  it(
    "replicates a team entry to a teammate's memory.db with its trust",
    async () => {
      const c = await cluster(['ada', 'bob']);
      stop = c.stop;
      const [ada, bob] = c.members as [Member, Member];
      await ada.handle.found();
      await quiesce(c.members);
      await ada.handle.admit(bob.handle);
      await quiesce(c.members);
      const saved = await ada.handle.api('/api/memory', {
        method: 'POST',
        body: JSON.stringify({
          scope: 'team',
          kind: 'fact',
          title: 'deploys freeze on Fridays',
          body: 'Nothing ships after 3pm Friday.',
        }),
      });
      expect(saved.status).toBe(201);
      const id = (saved.body as { id: string }).id;
      await quiesce(c.members);
      const there = await bob.handle.api(`/api/memory/${id}`);
      expect(there.status).toBe(200);
      expect(there.body).toMatchObject({
        entry: {
          id,
          title: 'deploys freeze on Fridays',
          trust: 'human',
          author: `human:${ada.handle.handle}`,
        },
      });
    },
    SLOW
  );
});
