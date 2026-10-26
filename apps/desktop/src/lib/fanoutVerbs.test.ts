import { statusModelOf } from '@dispatch-foo/core/browser';
import type { EpicProgress, EpicSessionState } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { testConfig } from '../components/settings/fixtures.test-helper';
import { FANOUT_VERB_LABEL, fanoutVerbs } from './fanoutVerbs';
import { taskDoc } from './taskDoc.test-helper';

const MODEL = statusModelOf(testConfig);
const epic = taskDoc({ id: 'e-1', title: 'Payments', kind: 'milestone' });
const landed = taskDoc({
  id: 'e-2',
  title: 'Shipped',
  kind: 'milestone',
  status: 'done',
});

function progress(
  state: EpicSessionState | null,
  children: { id: string; status: string }[]
): EpicProgress {
  return {
    epicId: 'e-1',
    active: state === 'active',
    session:
      state === null
        ? null
        : {
            epicId: 'e-1',
            concurrency: 2,
            executor: 'claude',
            state,
            maxSpendUsd: null,
            maxRuns: null,
            startedAt: '2026-10-20T10:00:00.000Z',
            startedBy: 'human:wyat',
            scope: 'plan',
            updatedAt: '2026-10-20T10:00:00.000Z',
          },
    spend: {
      settledUsd: 0,
      liveCount: 0,
      estimatedLiveUsd: 0,
      runsStarted: 0,
      maxSpendUsd: null,
      maxRuns: null,
    },
    children: children.map((child) => ({
      id: child.id,
      title: child.id,
      status: child.status,
      phase: 'queued',
      wave: 1,
      openFindings: 0,
    })),
    waves: [],
    liveRuns: [],
  } as unknown as EpicProgress;
}

describe('fanoutVerbs', () => {
  test('an active session offers Pause and Stop', () => {
    expect(
      fanoutVerbs(
        epic,
        MODEL,
        progress('active', [{ id: 't', status: 'todo' }])
      )
    ).toEqual(['pause', 'stop']);
  });

  test('a paused session offers Resume and Stop', () => {
    expect(
      fanoutVerbs(
        epic,
        MODEL,
        progress('paused', [{ id: 't', status: 'todo' }])
      )
    ).toEqual(['resume', 'stop']);
  });

  test('every child done and the container open offers Land', () => {
    expect(
      fanoutVerbs(
        epic,
        MODEL,
        progress('complete', [
          { id: 'a', status: 'done' },
          { id: 'b', status: 'cancelled' },
        ])
      )
    ).toEqual(['land']);
  });

  test('a landed container, or one with nothing to send, offers nothing', () => {
    expect(
      fanoutVerbs(landed, MODEL, progress(null, [{ id: 'a', status: 'done' }]))
    ).toEqual([]);
    expect(fanoutVerbs(epic, MODEL, progress(null, []))).toEqual([]);
    expect(fanoutVerbs(epic, MODEL, undefined, 0)).toEqual([]);
  });

  test('otherwise Send agents…, before the progress resolves too', () => {
    expect(
      fanoutVerbs(epic, MODEL, progress(null, [{ id: 'a', status: 'todo' }]))
    ).toEqual(['send']);
    expect(
      fanoutVerbs(
        epic,
        MODEL,
        progress('stopped', [
          { id: 'a', status: 'done' },
          { id: 'b', status: 'todo' },
        ])
      )
    ).toEqual(['send']);
    expect(fanoutVerbs(epic, MODEL, undefined)).toEqual(['send']);
    expect(fanoutVerbs(epic, MODEL, undefined, 3)).toEqual(['send']);
  });

  test('every verb has a menu word', () => {
    expect(Object.keys(FANOUT_VERB_LABEL).sort()).toEqual([
      'land',
      'pause',
      'resume',
      'send',
      'stop',
    ]);
  });
});
