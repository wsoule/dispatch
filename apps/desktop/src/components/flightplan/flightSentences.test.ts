import type { TaskListItem } from '@dispatch-foo/core/browser';
import { DEFAULT_STATUS_MODEL } from '@dispatch-foo/core/browser';
import type { EpicProgressChild, RunMeta } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import type { FlightNode, FlightNodeState } from './flightPlan';
import {
  joinRefs,
  nodeSentence,
  runStep,
  type SentenceInput,
} from './flightSentences';

function node(
  state: FlightNodeState,
  meta: Partial<TaskListItem['meta']> = {},
  extra: Partial<FlightNode> = {}
): FlightNode {
  return {
    task: {
      meta: {
        id: 't-1',
        title: 'One',
        status: 'ready',
        risk: 'routine',
        ...meta,
      },
    } as TaskListItem,
    state,
    wave: 0,
    waitingOn: [],
    subPlan: false,
    owner: 'e-1',
    holder: null,
    ...extra,
  };
}

const LINEAR: Record<string, string> = {
  't-398': 'ENG-398',
  't-405': 'ENG-405',
};

function input(
  n: FlightNode,
  over: Partial<SentenceInput> = {}
): SentenceInput {
  return {
    node: n,
    refFor: (id) => LINEAR[id] ?? id,
    sessionActive: false,
    queue: null,
    parkedBehind: null,
    run: undefined,
    phase: undefined,
    personName: null,
    model: DEFAULT_STATUS_MODEL,
    ...over,
  };
}

const text = (i: SentenceInput) => nodeSentence(i).text;

test('joinRefs', () => {
  expect(joinRefs(['A'])).toBe('A');
  expect(joinRefs(['A', 'B'])).toBe('A + B');
  expect(joinRefs(['A', 'B', 'C'])).toBe('A, B + C');
  expect(joinRefs(['A', 'B', 'C', 'D', 'E'])).toBe('A, B + 3 more');
});

describe('nodeSentence', () => {
  test('a blocked node names its blockers by their Linear ids', () => {
    const blocked = node(
      'blocked',
      { status: 'ready' },
      {
        waitingOn: ['t-398', 't-405'],
      }
    );
    expect(text(input(blocked, { sessionActive: true }))).toBe(
      'Auto-starts when ENG-398 + ENG-405 finish'
    );
    // With nothing fanning out, nothing starts on its own.
    expect(text(input(blocked))).toBe('Unblocks when ENG-398 + ENG-405 finish');
    expect(
      text(
        input(node('blocked', {}, { waitingOn: ['t-9'] }), {
          sessionActive: true,
        })
      )
    ).toBe('Auto-starts when t-9 finishes');
  });

  test('the other reasons a node is not moving', () => {
    expect(text(input(node('blocked', { status: 'draft' })))).toBe(
      'Draft · not ready to start'
    );
    expect(text(input(node('blocked', { risk: 'critical' })))).toBe(
      'Held · critical work starts by hand'
    );
    expect(text(input(node('blocked', {}, { subPlan: true })))).toBe(
      'Fans out on its own plan'
    );
    expect(text(input(node('blocked', { derivedFrom: 'github-pr:7' })))).toBe(
      'Anchors a review · agents never start it'
    );
    expect(
      text(
        input(node('blocked', { status: 'working' }), {
          run: { state: 'failed' } as RunMeta,
        })
      )
    ).toBe('Last run failed · press D to retry');
    expect(
      text(
        input(node('blocked', { status: 'working' }), {
          phase: { phase: 'capped' } as EpicProgressChild,
        })
      )
    ).toBe('Fix loop capped · needs a ruling');
  });

  test('queue position under the ceiling', () => {
    const queued = node('queued');
    expect(text(input(queued))).toBe('Ready to dispatch');
    const active = { sessionActive: true };
    expect(
      text(input(queued, { ...active, queue: { position: 0, free: 1 } }))
    ).toBe('Next up');
    expect(
      text(input(queued, { ...active, queue: { position: 2, free: 1 } }))
    ).toBe('#2 in queue');
    expect(
      text(
        input(queued, {
          ...active,
          queue: { position: 0, free: 2 },
          parkedBehind: 't-405',
        })
      )
    ).toBe('Parked behind ENG-405’s files');
  });

  test('done, teammate and review nodes', () => {
    expect(nodeSentence(input(node('done', { status: 'landed' })))).toEqual({
      text: 'Landed',
      tone: 'done',
    });
    expect(text(input(node('done', { status: 'dropped' })))).toBe('Dropped');
    expect(
      text(
        input(node('teammate', { status: 'working' }), {
          personName: 'Maya Chen',
        })
      )
    ).toBe('Maya’s · Working');
    expect(text(input(node('review', { status: 'review' })))).toBe(
      'Ready for review'
    );
    expect(text(input(node('review', { status: 'landing' })))).toBe('Landing');
  });
});

test('a teammate’s unstarted node says it will not auto-start', () => {
  const samTask = node(
    'teammate',
    { status: 'ready' },
    { holder: 'human:sam' }
  );
  expect(nodeSentence(input(samTask, { personName: 'Sam Rivera' }))).toEqual({
    text: 'Sam’s — won’t auto-start',
    tone: 'muted',
  });
  // Even under a live fan-out with slots free: it is never queued.
  expect(
    text(
      input(samTask, {
        personName: 'Sam',
        sessionActive: true,
        queue: { position: 0, free: 2 },
      })
    )
  ).toBe('Sam’s — won’t auto-start');
  expect(text(input(node('teammate', { status: 'draft' })))).toBe(
    'A teammate’s — won’t auto-start'
  );
});

test('runStep reads the run, then the fan-out phase', () => {
  const live = (extra: Partial<RunMeta>) =>
    ({ state: 'running', ...extra }) as RunMeta;
  expect(runStep(undefined, undefined)).toBe('Starting');
  expect(runStep(live({ state: 'awaiting-approval' }), undefined)).toBe(
    'Waiting on approval'
  );
  expect(runStep(live({ kind: 'review' }), undefined)).toBe('Reviewing');
  expect(runStep(live({}), { phase: 'fixing' } as EpicProgressChild)).toBe(
    'Fixing findings'
  );
  expect(runStep(live({}), undefined)).toBe('Working');
});
