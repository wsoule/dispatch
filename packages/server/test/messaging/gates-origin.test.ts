import { describe, expect, it } from 'bun:test';

import { closeOrphanedGates } from '../../src/messaging/gates.js';
import { makeOrchestrator, openRecovered, useTempProject } from './harness.js';

const project = useTempProject();

describe('only the settler closes', () => {
  it('a restart never closes a question that came from another replica', async () => {
    const { orchestrator, store } = makeOrchestrator(project.root());
    const messaging = await openRecovered(project.root(), orchestrator, store);
    const remote = {
      id: 'm-01remote-question',
      thread: 'm-01remote-question',
      replyTo: null,
      from: 'run:r-0000000000bb',
      to: ['human:wyat'],
      kind: 'question' as const,
      body: 'which schema?',
      refs: [],
      urgent: false,
      blocking: true,
      wake: 'none' as const,
      createdAt: '2026-09-26T10:00:00.000Z',
      hlc: '1758880000000.0001.bob-0000000b',
      origin: 'bob-0000000b',
    };
    messaging.store.insertMessage(remote, undefined, {
      receivedAt: '2026-09-26T10:00:01.000Z',
    });
    const local = await messaging.engine.send(
      {
        to: ['human:wyat'],
        kind: 'question',
        blocking: true,
        body: 'from a run that died',
      },
      { address: 'run:r-000001', canDecide: false }
    );
    closeOrphanedGates(messaging.engine, {
      isRunLive: () => false,
      taskIdOfRun: () => null,
    });
    expect(messaging.engine.answerOf(remote.id)).toBeNull();
    expect(messaging.engine.answerOf(local.message.id)?.data).toMatchObject({
      type: 'x-closed',
    });
    messaging.close();
  });
});
