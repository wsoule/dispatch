import type { RunMeta, RunState } from '@dispatch/client';
import type { GraphNodeData } from '@dispatch/ui';
import { describe, expect, test } from 'bun:test';

import { TASK_BUCKET_ORDER, type TaskBucket } from '../lib/taskStatus';
import { fixture } from './graphFixture.test-helper';
import {
  applyDispatchOverlay,
  type DispatchOverlayContext,
} from './graphOverlay';
import { bucketChip, liveRunWord } from './rows';

// The Dispatch overlay on the graph's issue boxes: the bucket's word (and a
// live run's) after the planning tags, the strong claims' hue on the box,
// readiness.canStart from the ready set, and containers left alone. The
// words come from rows.ts's one table, so the list and the graph agree.

function issueNode(overrides: Partial<GraphNodeData> = {}): GraphNodeData {
  return {
    id: 't1',
    label: 'Client queue',
    sublabel: 'DSP-3 · Ana',
    tone: 'default',
    status: 'open',
    statusLabel: 'Ready',
    tags: [],
    readiness: {
      state: 'ready',
      label: 'Ready',
      tone: 'success',
      blockedBy: 0,
      unblocks: 1,
    },
    ...overrides,
  };
}

function context(
  overrides: Partial<DispatchOverlayContext> = {}
): DispatchOverlayContext {
  return {
    bucketOf: () => null,
    readyIds: new Set(['t1']),
    isTaskNode: () => true,
    ...overrides,
  };
}

/** The overlay on one task box in `bucket`, with a live run when given. */
function overlaid(
  bucket: TaskBucket | null,
  live?: RunState,
  node: GraphNodeData = issueNode()
): GraphNodeData {
  const [out] = applyDispatchOverlay([node], {
    ...context({ bucketOf: () => bucket }),
    liveRunStateByTaskId:
      live === undefined ? undefined : new Map([['t1', live]]),
  });
  if (out === undefined) throw new Error('one node in, one out');
  return out;
}

describe('applyDispatchOverlay', () => {
  test('every bucket reads as the list’s chip, in the list’s words', () => {
    const words = Object.fromEntries(
      TASK_BUCKET_ORDER.map((bucket) => [
        bucket,
        overlaid(bucket, 'running').tags,
      ])
    );
    expect(words).toEqual({
      'need-you': ['Needs you'],
      failed: ['Failed'],
      working: ['Agent working'],
      review: ['Review'],
      landing: ['Landing'],
      // Ready and draft say nothing the state glyph does not.
      ready: [],
      draft: [],
      blocked: ['Blocked'],
    });
    for (const bucket of TASK_BUCKET_ORDER) {
      const chip = bucketChip(bucket, 'running');
      expect(words[bucket]).toEqual(chip === undefined ? [] : [chip.label]);
    }
    expect(overlaid(null).tags).toEqual([]);
  });

  test('the strong claims hue the box; Review, Landing and Blocked are words alone', () => {
    const tones = Object.fromEntries(
      TASK_BUCKET_ORDER.map((bucket) => [
        bucket,
        overlaid(bucket, 'running').tone,
      ])
    );
    expect(tones).toEqual({
      'need-you': 'warning',
      failed: 'danger',
      working: 'info',
      review: 'default',
      landing: 'default',
      ready: 'default',
      draft: 'default',
      blocked: 'default',
    });
  });

  test('"Agent working" is claimed only over a live run', () => {
    // A started status with no run (a person moved it): no chip, no hue.
    expect(overlaid('working')).toMatchObject({ tags: [], tone: 'default' });
    expect(overlaid('working', 'running')).toMatchObject({
      tags: ['Agent working'],
      tone: 'info',
    });
    // The live state's own word follows where it says more.
    expect(overlaid('working', 'provisioning').tags).toEqual([
      'Agent working',
      'Provisioning',
    ]);
    expect(overlaid('need-you', 'awaiting-approval').tags).toEqual([
      'Needs you',
      'Awaiting approval',
    ]);
    expect(liveRunWord('running')).toBeUndefined();
    expect(liveRunWord(undefined)).toBeUndefined();
    expect(liveRunWord('provisioning')).toBe('Provisioning');
  });

  test('the latest run stands in for the live map while it is not finished', () => {
    const latest = (state: RunState) =>
      new Map<string, RunMeta>([
        ['t1', { id: 'r1', taskId: 't1', state } as RunMeta],
      ]);
    const over = (state: RunState) =>
      applyDispatchOverlay([issueNode()], {
        ...context({ bucketOf: () => 'working' }),
        latestRunByTaskId: latest(state),
      })[0];
    expect(over('running')?.tags).toEqual(['Agent working']);
    expect(over('provisioning')?.tags).toEqual([
      'Agent working',
      'Provisioning',
    ]);
    // A finished run is no live run.
    expect(over('finished')?.tags).toEqual([]);
    expect(over('failed')?.tone).toBe('default');
    // The live map wins when both are given.
    expect(
      applyDispatchOverlay([issueNode()], {
        ...context({ bucketOf: () => 'working' }),
        liveRunStateByTaskId: new Map([['t1', 'awaiting-approval']]),
        latestRunByTaskId: latest('running'),
      })[0]?.tags
    ).toEqual(['Agent working', 'Awaiting approval']);
  });

  test('the overlay follows the planning tags, and never outranks a louder box', () => {
    const overdue = issueNode({
      tone: 'danger',
      tags: ['Unassigned', 'Overdue'],
    });
    expect(overlaid('need-you', undefined, overdue)).toMatchObject({
      tags: ['Unassigned', 'Overdue', 'Needs you'],
      // The red overdue box stays red under an amber claim.
      tone: 'danger',
    });
    expect(overlaid('failed', undefined, overdue).tone).toBe('danger');
    const unassigned = issueNode({ tone: 'warning', tags: ['Unassigned'] });
    expect(overlaid('failed', undefined, unassigned).tone).toBe('danger');
    expect(overlaid('working', 'running', unassigned).tone).toBe('warning');
    expect(overlaid('need-you', undefined, unassigned).tone).toBe('warning');
    // A quiet box (paused work) keeps its quiet, whatever the claim.
    const paused = issueNode({ tone: 'muted', tags: ['Inactive'] });
    expect(overlaid('failed', undefined, paused)).toMatchObject({
      tags: ['Inactive', 'Failed'],
      tone: 'muted',
    });
    // A box with no tags gets the overlay's alone.
    const bare = issueNode({ tags: undefined });
    expect(overlaid('review', undefined, bare).tags).toEqual(['Review']);
    expect(overlaid(null, undefined, bare).tags).toBeUndefined();
  });

  test('readiness.canStart follows the ready set', () => {
    const nodes = [
      issueNode({ id: 'ready' }),
      issueNode({
        id: 'waiting',
        readiness: {
          state: 'blocked',
          label: 'Blocked by 1',
          tone: 'warning',
          blockedBy: 1,
          unblocks: 0,
        },
      }),
      issueNode({ id: 'bare', readiness: undefined }),
    ];
    const out = applyDispatchOverlay(
      nodes,
      context({ readyIds: new Set(['ready']) })
    );
    expect(out.map((n) => [n.id, n.readiness?.canStart])).toEqual([
      ['ready', true],
      ['waiting', false],
      ['bare', undefined],
    ]);
    // The planning readiness is kept beside it.
    expect(out[1]?.readiness).toEqual({
      state: 'blocked',
      label: 'Blocked by 1',
      tone: 'warning',
      blockedBy: 1,
      unblocks: 0,
      canStart: false,
    });
    // A ready set that does not hold a ready box says it cannot start.
    expect(
      applyDispatchOverlay([issueNode()], context({ readyIds: new Set() }))[0]
        ?.readiness?.canStart
    ).toBe(false);
  });

  test('containers are untouched, the same object', () => {
    const container = issueNode({
      id: 'ms-1',
      label: 'Dual-write',
      readiness: {
        state: 'ready',
        label: 'Clear',
        tone: 'success',
        blockedBy: 0,
        unblocks: 2,
        canStart: true,
      },
    });
    const task = issueNode({ id: 't1' });
    const out = applyDispatchOverlay([container, task], {
      ...context({ bucketOf: () => 'failed', readyIds: new Set() }),
      isTaskNode: (id) => id === 't1',
    });
    expect(out[0]).toBe(container);
    expect(out[1]).not.toBe(task);
    expect(out[1]).toMatchObject({ tags: ['Failed'], tone: 'danger' });
    expect(out[1]?.readiness?.canStart).toBe(false);
    // The input is never mutated.
    expect(task.tags).toEqual([]);
    expect(task.tone).toBe('default');
    expect(task.readiness?.canStart).toBeUndefined();
  });

  test('over the page model: issue boxes take the overlay, the frames’ boxes do not', () => {
    const { page, snapshot } = fixture();
    const issues = page({ level: 'issue', milestoneId: 'ms-atlas-2' });
    const asks = new Set(['iss-12']);
    const out = applyDispatchOverlay(issues.nodes, {
      bucketOf: (id) =>
        asks.has(id) ? 'need-you' : id === 'iss-10' ? 'working' : 'ready',
      readyIds: new Set(['iss-10', 'iss-11', 'iss-13']),
      liveRunStateByTaskId: new Map([['iss-10', 'running']]),
      isTaskNode: (id) => snapshot.issues.has(id),
    });
    expect(
      out.map((n) => [n.key, n.tags, n.tone, n.readiness?.canStart])
    ).toEqual([
      // Overdue (red) stays over the blue of a live run.
      ['ENG-10', ['Overdue', 'Agent working'], 'danger', true],
      ['ENG-11', ['Overdue'], 'danger', true],
      ['ENG-12', ['Unassigned', 'Overdue', 'Needs you'], 'danger', false],
      ['ENG-13', ['Unassigned', 'Overdue'], 'danger', true],
      ['ENG-16', [], 'default', false],
      ['ENG-23', [], 'default', false],
    ]);
    // Milestone boxes are containers: the same objects come back.
    const milestones = page({ level: 'milestone' });
    const kept = applyDispatchOverlay(milestones.nodes, {
      bucketOf: () => 'failed',
      readyIds: new Set(),
      isTaskNode: (id) => snapshot.issues.has(id),
    });
    kept.forEach((node, i) => expect(node).toBe(milestones.nodes[i]));
  });
});
