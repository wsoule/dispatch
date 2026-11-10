import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DecisionAckStore } from '../src/decisionAcks.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-acks-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ack = { fingerprint: 'r-1:failed:failed:', dismissedAt: 'x' };

describe('DecisionAckStore', () => {
  it('reads back what an earlier instance wrote, as a restarted daemon would', () => {
    new DecisionAckStore(root).set('run-stalled:r-1', ack);
    expect(new DecisionAckStore(root).get('run-stalled:r-1')).toEqual(ack);
  });

  it('forgets a deleted ack on disk too', () => {
    const store = new DecisionAckStore(root);
    store.set('run-stalled:r-1', ack);
    expect(store.delete('run-stalled:r-1')).toBe(true);
    expect(store.delete('run-stalled:r-1')).toBe(false);
    expect(new DecisionAckStore(root).get('run-stalled:r-1')).toBeUndefined();
  });

  it('treats a mangled file as nothing dismissed', () => {
    mkdirSync(join(root, '.dispatch'));
    writeFileSync(join(root, '.dispatch', 'decision-acks.json'), '{ nope');
    expect(new DecisionAckStore(root).get('run-stalled:r-1')).toBeUndefined();
  });
});
