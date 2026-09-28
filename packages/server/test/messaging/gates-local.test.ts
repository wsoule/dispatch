import { describe, expect, it } from 'bun:test';

import { openHumanDecisions } from '../../src/messaging/gates.js';
import {
  HUMAN,
  makeOrchestrator,
  openRecovered,
  useTempProject,
} from './harness.js';

const project = useTempProject();

describe('Needs you shows only what is local', () => {
  it('lists a blocking question with a local human delivery and not one only a remote human holds', async () => {
    const { orchestrator, store } = makeOrchestrator(project.root());
    const messaging = await openRecovered(project.root(), orchestrator, store);
    try {
      const local = await messaging.engine.send(
        { to: ['human:wyat'], kind: 'question', blocking: true, body: 'mine?' },
        { address: 'agent:dispatch', canDecide: true }
      );
      const away = await messaging.engine.send(
        { to: ['human:bob'], kind: 'question', blocking: true, body: 'his?' },
        HUMAN
      );
      // No delivery here stands in for a recipient homed on another replica.
      for (const d of messaging.engine.deliveriesOf(away.message.id))
        messaging.store.deleteDelivery(d.id);
      const ids = openHumanDecisions(messaging.engine).map((m) => m.id);
      expect(ids).toContain(local.message.id);
      expect(ids).not.toContain(away.message.id);
    } finally {
      messaging.close();
    }
  });
});
