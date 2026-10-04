import { describe, expect, it } from 'bun:test';

import { call, invite, liveRun, useWorld } from './world.js';

// Rate caps a run or agent cannot multiply by fanning out (XH-R2, M4).

const world = useWorld();

describe('the urgent quota for runs', () => {
  it('is shared by every run acting for the same operator', async () => {
    const w = world();
    const ada = await invite(w, 'ada@x.io', 'request');
    const first = await liveRun(w, w.app, 'one');
    const sibling = await liveRun(w, w.app, 'two');
    const adas = await liveRun(w, ada.token, 'ada');
    const urgent = (token: string) =>
      call(w, token, 'POST', '/api/messages', {
        to: ['human:test'],
        kind: 'message',
        body: 'u',
        urgent: true,
      });
    for (let i = 0; i < 10; i++) {
      expect((await urgent(first.runToken)).json.message.urgent).toBe(true);
    }
    // A sibling for the same operator is over the quota already…
    const over = await urgent(sibling.runToken);
    expect(over.json.message.urgent).toBe(false);
    expect(over.json.downgraded).toBe(true);
    // …and a run for someone else keeps its own.
    expect((await urgent(adas.runToken)).json.message.urgent).toBe(true);
  });
});
