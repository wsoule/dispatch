import { beforeEach, describe, expect, it } from 'bun:test';

import type {
  DecisionFeedContext,
  DecisionItem,
  DecisionPolicy,
} from '../src/decisionFeed.js';
import { DecisionFeed } from '../src/decisionFeed.js';
import { EventBus } from '../src/events.js';
import type { ServerEvent } from '../src/events.js';
import type { FixLoopState } from '../src/orchestrator/fixLoop.js';
import { QuestionRegistry } from '../src/orchestrator/questions.js';
import { ScopeRequestRegistry } from '../src/orchestrator/scopeRequests.js';
import type { RunMeta, RunState } from '../src/orchestrator/types.js';

const T0 = Date.parse('2026-08-22T12:00:00.000Z');

function runMeta(id: string, patch: Partial<RunMeta> = {}): RunMeta {
  return {
    id,
    taskId: `t-${id}`,
    taskTitle: `Task ${id}`,
    executor: 'fake',
    state: 'running' as RunState,
    branch: `dispatch/${id}`,
    baseBranch: 'main',
    worktreePath: `/tmp/${id}`,
    createdAt: new Date(T0 - 60_000).toISOString(),
    updatedAt: new Date(T0 - 60_000).toISOString(),
    ...patch,
  };
}

// The whole feed stood up over in-memory stand-ins, so a test can put any run,
// approval or fix-loop state in front of it without a daemon or a worktree.
// `now` is a mutable clock so age and the resolved-item retention window are
// assertable without sleeping.
interface Harness {
  feed: DecisionFeed;
  events: EventBus;
  questions: QuestionRegistry;
  scopeRequests: ScopeRequestRegistry;
  runs: RunMeta[];
  approvals: ReturnType<
    DecisionFeedContext['orchestrator']['pendingApprovals']
  >;
  loops: FixLoopState[];
  titles: Map<string, string>;
  setNow(ms: number): void;
}

function harness(policy?: DecisionPolicy): Harness {
  const events = new EventBus();
  const questions = new QuestionRegistry();
  const scopeRequests = new ScopeRequestRegistry();
  const runs: RunMeta[] = [];
  const approvals: Harness['approvals'] = [];
  const loops: FixLoopState[] = [];
  const titles = new Map<string, string>();
  let now = T0;
  const feed = new DecisionFeed({
    orchestrator: {
      list: () => runs,
      pendingApprovals: () => approvals,
    },
    questions,
    scopeRequests,
    fixLoopStore: { list: () => loops },
    cache: {
      get: (id) => {
        const title = titles.get(id);
        return title === undefined ? null : { meta: { title } };
      },
    },
    events,
    policy,
    now: () => now,
  });
  return {
    feed,
    events,
    questions,
    scopeRequests,
    runs,
    approvals,
    loops,
    titles,
    setNow: (ms) => {
      now = ms;
    },
  };
}

function cappedLoop(
  taskId: string,
  patch: Partial<FixLoopState> = {}
): FixLoopState {
  return {
    taskId,
    round: 3,
    cap: 3,
    state: 'capped',
    baseSha: 'abc123',
    lastReviewedSha: null,
    stopReason: 'rounds-exhausted',
    updatedAt: new Date(T0 - 30_000).toISOString(),
    ...patch,
  };
}

function byKind(items: DecisionItem[], kind: string): DecisionItem[] {
  return items.filter((item) => item.kind === kind);
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe('DecisionFeed aggregation', () => {
  it('collects all five kinds with their task/run reference, age and open state', () => {
    const live = runMeta('r-live', { state: 'awaiting-approval' });
    const dead = runMeta('r-dead', {
      state: 'failed',
      updatedAt: new Date(T0 - 120_000).toISOString(),
    });
    h.runs.push(live, dead);
    h.approvals.push({
      runId: live.id,
      taskId: live.taskId,
      taskTitle: live.taskTitle,
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'rm -rf /' },
    });
    h.questions.ask(live.id, 'Which database?', ['sqlite']);
    h.scopeRequests.request(live.id, ['src/a.ts'], 'needs the shared helper');
    h.titles.set('t-99', 'Capped task');
    h.loops.push(cappedLoop('t-99'));

    const items = h.feed.list();
    expect(items.map((item) => item.kind).sort()).toEqual([
      'approval',
      'fix-loop-capped',
      'question',
      'run-stalled',
      'scope-request',
    ]);
    expect(items.every((item) => item.state === 'open')).toBe(true);

    const approval = byKind(items, 'approval')[0];
    expect(approval.id).toBe('approval:req-1');
    expect(approval.runId).toBe('r-live');
    expect(approval.taskId).toBe('t-r-live');
    expect(approval.summary).toContain('Bash');
    expect(approval.ageMs).toBe(60_000);

    const scope = byKind(items, 'scope-request')[0];
    expect(scope.runId).toBe('r-live');
    // Resolved off the run, which the registry record itself never carries.
    expect(scope.taskTitle).toBe('Task r-live');
    expect(scope.reason).toBe('needs the shared helper');

    const capped = byKind(items, 'fix-loop-capped')[0];
    expect(capped.id).toBe('fix-loop-capped:t-99');
    expect(capped.taskTitle).toBe('Capped task');
    expect(capped.reason).toBe('rounds-exhausted');
    expect(capped.summary).toContain('round 3 of 3');

    const stalled = byKind(items, 'run-stalled')[0];
    expect(stalled.id).toBe('run-stalled:r-dead');
    expect(stalled.reason).toBe('failed');
    expect(stalled.ageMs).toBe(120_000);
  });

  it('orders open items longest-waiting first', () => {
    const run = runMeta('r-1');
    h.runs.push(run);
    h.setNow(T0);
    const older = h.questions.ask(run.id, 'first');
    h.setNow(T0 + 5_000);
    const newer = h.questions.ask(run.id, 'second');
    h.setNow(T0 + 10_000);

    // askedAt comes from the registry's own clock, so order by it rather than
    // by the ids, which are random.
    const ids = h.feed.list().map((item) => item.id);
    const expected = [older, newer]
      .sort((a, b) => a.askedAt.localeCompare(b.askedAt))
      .map((q) => `question:${q.id}`);
    expect(ids).toEqual(expected);
  });

  it('marks a run stalled for the strongest reason and skips ones already dealt with', () => {
    h.runs.push(
      runMeta('r-base', { state: 'failed', baseDiscarded: true }),
      runMeta('r-dirty', { state: 'interrupted-dirty' }),
      runMeta('r-orphan', {
        state: 'failed',
        survey: {
          runId: 'r-orphan',
          branch: 'dispatch/r-orphan',
          staged: [],
          unstaged: [],
          untracked: [],
          lastCommit: null,
          cleanTree: true,
          postFailCommits: [
            { sha: 'aaa', subject: 'late work', date: '2026-08-22T11:00:00Z' },
          ],
        },
      }),
      runMeta('r-cancelled', { state: 'cancelled' }),
      runMeta('r-running', { state: 'running' }),
      runMeta('r-reviewed', {
        state: 'failed',
        reviewedAt: '2026-08-22T11:00:00Z',
      }),
      runMeta('r-archived', {
        state: 'failed',
        archivedAt: '2026-08-22T11:00:00Z',
      })
    );

    const stalled = byKind(h.feed.list(), 'run-stalled');
    expect(
      Object.fromEntries(stalled.map((item) => [item.runId, item.reason]))
    ).toEqual({
      'r-base': 'base-discarded',
      'r-dirty': 'interrupted-dirty',
      'r-orphan': 'orphan-commits',
    });
  });

  it('leaves a fix loop that is still running out of the feed', () => {
    h.loops.push(
      cappedLoop('t-a', { state: 'reviewing' }),
      cappedLoop('t-b', { state: 'complete' }),
      cappedLoop('t-c')
    );
    expect(
      byKind(h.feed.list(), 'fix-loop-capped').map((i) => i.taskId)
    ).toEqual(['t-c']);
  });
});

describe('DecisionFeed resolution', () => {
  it('drops an answered question and reports it once as resolved', () => {
    const run = runMeta('r-1');
    h.runs.push(run);
    const question = h.questions.ask(run.id, 'Which database?');
    expect(h.feed.list()).toHaveLength(1);

    h.questions.answer(question.id, 'sqlite');
    h.setNow(T0 + 1_000);
    expect(h.feed.list()).toHaveLength(0);

    const withResolved = h.feed.list({ includeResolved: true });
    expect(withResolved).toHaveLength(1);
    expect(withResolved[0].state).toBe('resolved');
    expect(withResolved[0].resolvedAt).toBe(new Date(T0 + 1_000).toISOString());
  });

  it('keeps counting a resolved item age from when it started waiting', () => {
    // A stalled run, whose `since` is the run's own updatedAt rather than the
    // registry's real clock, so the fake clock governs the whole measurement.
    h.runs.push(runMeta('r-1', { state: 'failed' }));
    expect(h.feed.list()[0].ageMs).toBe(60_000);

    h.runs[0] = runMeta('r-1', {
      state: 'failed',
      reviewedAt: '2026-08-22T11:00:00Z',
    });
    h.setNow(T0 + 30_000);
    const resolved = h.feed.list({ includeResolved: true })[0];
    expect(resolved.state).toBe('resolved');
    expect(resolved.ageMs).toBe(90_000);
  });

  it('forgets a resolved item once its retention window passes', () => {
    const run = runMeta('r-1');
    h.runs.push(run);
    const question = h.questions.ask(run.id, 'Which database?');
    h.feed.list();
    h.questions.answer(question.id, 'sqlite');
    h.setNow(T0 + 1_000);
    expect(h.feed.list({ includeResolved: true })).toHaveLength(1);

    h.setNow(T0 + 1_000 + 5 * 60_000 + 1);
    expect(h.feed.list({ includeResolved: true })).toHaveLength(0);
  });

  it('treats an id that comes back as open, not resolved', () => {
    h.loops.push(cappedLoop('t-99'));
    expect(h.feed.list()).toHaveLength(1);

    // Adjudicated: the loop leaves `capped`, so the item resolves.
    h.loops[0] = cappedLoop('t-99', { state: 'implementing' });
    h.setNow(T0 + 1_000);
    expect(h.feed.list({ includeResolved: true })[0].state).toBe('resolved');

    // ...and caps again on the same task, which reuses the same item id.
    h.loops[0] = cappedLoop('t-99', { round: 4, cap: 4 });
    h.setNow(T0 + 2_000);
    const items = h.feed.list({ includeResolved: true });
    expect(items).toHaveLength(1);
    expect(items[0].state).toBe('open');
  });

  it('caps how many resolved items it retains', () => {
    for (let i = 0; i < 60; i += 1) {
      h.runs.push(runMeta(`r-${i}`, { state: 'failed' }));
    }
    expect(h.feed.list()).toHaveLength(60);

    // All 60 reviewed at once: without a cap the feed would keep every one of
    // them for the whole retention window.
    h.runs.splice(0, h.runs.length);
    h.setNow(T0 + 1_000);
    expect(h.feed.list({ includeResolved: true })).toHaveLength(50);
  });

  it('reports nothing resolved on the very first read', () => {
    h.runs.push(runMeta('r-1', { state: 'failed' }));
    expect(
      h.feed.list({ includeResolved: true }).every((i) => i.state === 'open')
    ).toBe(true);
  });
});

describe('DecisionFeed live updates', () => {
  function capture(bus: EventBus): ServerEvent[] {
    const seen: ServerEvent[] = [];
    bus.subscribe((event) => {
      if (event.type === 'decisions.changed') seen.push(event);
    });
    return seen;
  }

  it('broadcasts decisions.changed when a source event changes the feed', () => {
    const stop = h.feed.start();
    const seen = capture(h.events);
    const run = runMeta('r-1');
    h.runs.push(run);
    h.questions.ask(run.id, 'Which database?');

    h.events.broadcast({
      type: 'question.asked',
      runId: run.id,
      questionId: 'q-1',
    });
    expect(seen).toHaveLength(1);
    stop();
  });

  it('stays quiet when a source event leaves the feed unchanged', () => {
    const stop = h.feed.start();
    const seen = capture(h.events);
    h.events.broadcast({ type: 'run.changed' });
    expect(seen).toHaveLength(0);
    stop();
  });

  it('ignores events that cannot change what awaits a human', () => {
    const stop = h.feed.start();
    const seen = capture(h.events);
    const run = runMeta('r-1');
    h.runs.push(run);
    h.questions.ask(run.id, 'Which database?');

    // A streamed log line is the high-frequency event this feed must not
    // recompute on.
    h.events.broadcast({
      type: 'run.log',
      runId: run.id,
      entry: { ts: new Date(T0).toISOString(), kind: 'assistant', text: 'hi' },
    });
    expect(seen).toHaveLength(0);
    stop();
  });

  // A GET /api/decisions recomputes the feed, so a client polling at the wrong
  // moment used to swallow the broadcast for every other client: the read moved
  // the change-detection baseline forward, and the event that followed compared
  // the new state against itself.
  it('still broadcasts when a read has already observed the change', () => {
    const stop = h.feed.start();
    const seen = capture(h.events);
    const run = runMeta('r-1');
    h.runs.push(run);
    h.questions.ask(run.id, 'Which database?');

    // The poll lands between the registry write and the event it triggers.
    h.feed.list();

    h.events.broadcast({
      type: 'question.asked',
      runId: run.id,
      questionId: 'q-1',
    });
    expect(seen).toHaveLength(1);
    stop();
  });

  // An orphaned agent that kept committing escalates a stalled run's reason
  // from 'failed' to 'orphan-commits' without its id or state moving — which
  // is exactly why run.survey is a trigger event. A signature keyed on id and
  // state alone could not see it, so the escalation reached no one.
  it('broadcasts when a stalled run escalates without changing state', () => {
    const stop = h.feed.start();
    const seen = capture(h.events);
    h.runs.push(runMeta('r-1', { state: 'failed' }));
    h.events.broadcast({ type: 'run.changed' });
    expect(seen).toHaveLength(1);
    expect(h.feed.list()[0].reason).toBe('failed');

    const survey = {
      runId: 'r-1',
      branch: 'dispatch/r-1',
      staged: [],
      unstaged: [],
      untracked: [],
      lastCommit: null,
      cleanTree: true,
      postFailCommits: [
        { sha: 'aaa', subject: 'late work', date: '2026-08-22T11:00:00Z' },
      ],
    };
    h.runs[0] = runMeta('r-1', { state: 'failed', survey });
    h.events.broadcast({ type: 'run.survey', runId: 'r-1', survey });

    expect(seen).toHaveLength(2);
    expect(h.feed.list()[0].reason).toBe('orphan-commits');
    stop();
  });

  it('stops broadcasting once unsubscribed', () => {
    const stop = h.feed.start();
    const seen = capture(h.events);
    stop();
    const run = runMeta('r-1');
    h.runs.push(run);
    h.questions.ask(run.id, 'Which database?');
    h.events.broadcast({
      type: 'question.asked',
      runId: run.id,
      questionId: 'q-1',
    });
    expect(seen).toHaveLength(0);
  });
});

describe('DecisionFeed policy seam', () => {
  it('classifies every item as blocking by default', () => {
    h.runs.push(runMeta('r-1', { state: 'failed' }));
    expect(h.feed.list().map((item) => item.disposition)).toEqual(['blocking']);
    expect(h.feed.count('blocking')).toBe(1);
    expect(h.feed.count('recorded')).toBe(0);
  });

  it('filters on the disposition an injected policy assigns', () => {
    const withPolicy = harness((item) =>
      item.kind === 'run-stalled' ? 'recorded' : 'blocking'
    );
    withPolicy.runs.push(runMeta('r-1', { state: 'failed' }));
    withPolicy.questions.ask('r-1', 'Which database?');

    expect(
      withPolicy.feed.list({ disposition: 'blocking' }).map((i) => i.kind)
    ).toEqual(['question']);
    expect(
      withPolicy.feed.list({ disposition: 'recorded' }).map((i) => i.kind)
    ).toEqual(['run-stalled']);
    expect(withPolicy.feed.list()).toHaveLength(2);
  });
});
