import type { JsonValue, Message } from '@dispatch/protocol';
import { beforeEach, describe, expect, it } from 'bun:test';

import type { DecisionItem, DecisionPolicy } from '../src/decisionFeed.js';
import { DecisionFeed } from '../src/decisionFeed.js';
import { EventBus } from '../src/events.js';
import type { ServerEvent } from '../src/events.js';
import { floorCheckForToolInput } from '../src/floor.js';
import {
  previewToolInput,
  toolApprovalGateData,
} from '../src/messaging/toolApproval.js';
import type { FixLoopState } from '../src/orchestrator/fixLoop.js';
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

// An open blocking question addressed to a human, as the engine stores it.
function gate(id: string, over: Partial<Message>): Message {
  return {
    id,
    thread: id,
    replyTo: null,
    from: 'agent:dispatch',
    to: ['human:wyat'],
    kind: 'question',
    body: 'q',
    refs: [],
    urgent: false,
    blocking: true,
    wake: 'none',
    createdAt: '2026-09-25T10:00:00.000Z',
    ...over,
  };
}

// The ISO time `ms` milliseconds before T0.
function ago(ms: number): string {
  return new Date(T0 - ms).toISOString();
}

// A tool-approval gate for `runId`'s parked call, carrying `input` as its
// preview and its floor flag as the raiser judged it.
function approvalGate(
  id: string,
  runId: string,
  requestId: string,
  input: JsonValue,
  over: Partial<Message> = {}
): Message {
  return gate(id, {
    data: {
      type: 'tool-approval',
      requestId,
      runId,
      tool: 'Bash',
      input,
      floor: floorCheckForToolInput(input) !== null,
    },
    ...over,
  });
}

// A plain question a run asked a human.
function runQuestion(
  id: string,
  runId: string,
  body: string,
  over: Partial<Message> = {}
): Message {
  return gate(id, { from: `run:${runId}`, body, ...over });
}

// The whole feed stood up over in-memory stand-ins, so a test can put any run,
// open gate or fix-loop state in front of it without a daemon or a worktree.
// `now` is a mutable clock so age and the resolved-item retention window are
// assertable without sleeping.
interface Harness {
  feed: DecisionFeed;
  events: EventBus;
  gates: Message[];
  pending: Map<string, { requestId: string; input: unknown }>;
  runs: RunMeta[];
  loops: FixLoopState[];
  titles: Map<string, string>;
  setNow(ms: number): void;
}

function harness(policy?: DecisionPolicy): Harness {
  const events = new EventBus();
  const gates: Message[] = [];
  const pending: Harness['pending'] = new Map();
  const runs: RunMeta[] = [];
  const loops: FixLoopState[] = [];
  const titles = new Map<string, string>();
  let now = T0;
  const feed = new DecisionFeed({
    orchestrator: {
      list: () => runs,
      pendingApprovalFor: (runId, requestId) => {
        const parked = pending.get(runId);
        return parked?.requestId === requestId ? parked : undefined;
      },
    },
    openGates: () => gates,
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
    gates,
    pending,
    runs,
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
  it('builds approval, scope and question items from open gates', () => {
    const runs = [
      runMeta('r-000001', {
        taskId: 't-000001',
        taskTitle: 'Checkout',
        state: 'awaiting-approval',
      }),
    ];
    const feed = new DecisionFeed({
      orchestrator: {
        list: () => runs,
        pendingApprovalFor: () => ({
          requestId: 'req-1',
          input: { command: 'git push --force origin main' },
        }),
      },
      openGates: () => [
        gate('m-a', {
          data: {
            type: 'tool-approval',
            requestId: 'req-1',
            runId: 'r-000001',
            tool: 'Bash',
            input: 'echo ok && …',
            truncated: true,
            floor: true,
          },
        }),
        gate('m-s', {
          from: 'run:r-000001',
          choices: ['grant', 'deny'],
          data: {
            type: 'scope',
            paths: ['a.ts', 'b.ts'],
            reason: 'needs both',
          },
        }),
        gate('m-q', { from: 'run:r-000001', body: 'Which cart?\nmore' }),
        gate('m-w', {
          data: { type: 'wake', target: 'task:t-000002', message: 'm-x' },
        }),
      ],
      fixLoopStore: { list: () => [] },
      cache: {
        get: (id) => ({
          meta: { title: id === 't-000002' ? 'Sleeper' : 'Checkout' },
        }),
      },
      events: new EventBus(),
    });
    const items = feed.list();
    expect(items.map((i) => i.id)).toEqual([
      'approval:m-a',
      'scope-request:m-s',
      'question:m-q',
      'approval:m-w',
    ]);
    expect(items[0]).toMatchObject({
      runId: 'r-000001',
      taskId: 't-000001',
      summary: 'Checkout: agent is waiting for permission to use Bash',
    });
    // Pins the floor from the full input, not the truncated preview.
    expect(items[0].floor).toBeDefined();
    // An approval's reason names the gate behind it.
    expect(items[0].reason).toBe('tool-approval');
    expect(items[1]).toMatchObject({
      paths: ['a.ts', 'b.ts'],
      reason: 'needs both',
    });
    // oneLine() flattens the question's whitespace into one summary line.
    expect(items[2].summary).toBe('Which cart? more');
    expect(items[3]).toMatchObject({
      taskId: 't-000002',
      taskTitle: 'Sleeper',
      reason: 'wake',
    });
  });

  it('collects all five kinds with their task/run reference, age and open state', () => {
    const live = runMeta('r-live', { state: 'awaiting-approval' });
    const dead = runMeta('r-dead', {
      state: 'failed',
      updatedAt: new Date(T0 - 120_000).toISOString(),
    });
    h.runs.push(live, dead);
    h.gates.push(
      approvalGate(
        'm-approval',
        live.id,
        'req-1',
        { command: 'rm -rf /' },
        { createdAt: ago(60_000) }
      ),
      runQuestion('m-question', live.id, 'Which database?', {
        createdAt: ago(50_000),
      }),
      gate('m-scope', {
        from: `run:${live.id}`,
        choices: ['grant', 'deny'],
        data: {
          type: 'scope',
          paths: ['src/a.ts'],
          reason: 'needs the shared helper',
        },
        createdAt: ago(40_000),
      })
    );
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
    expect(approval.id).toBe('approval:m-approval');
    expect(approval.runId).toBe('r-live');
    expect(approval.taskId).toBe('t-r-live');
    expect(approval.summary).toContain('Bash');
    expect(approval.ageMs).toBe(60_000);

    const question = byKind(items, 'question')[0];
    expect(question.id).toBe('question:m-question');
    expect(question.taskTitle).toBe('Task r-live');
    expect(question.summary).toBe('Which database?');

    const scope = byKind(items, 'scope-request')[0];
    expect(scope.runId).toBe('r-live');
    // Resolved off the run, which the gate itself never carries.
    expect(scope.taskTitle).toBe('Task r-live');
    expect(scope.reason).toBe('needs the shared helper');
    expect(scope.summary).toBe(
      'agent asked to edit outside its scope: src/a.ts'
    );

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

  it('names at most three paths in a scope summary and keeps the rest in paths', () => {
    h.runs.push(runMeta('r-1'));
    const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
    h.gates.push(
      gate('m-scope', {
        from: 'run:r-1',
        choices: ['grant', 'deny'],
        data: { type: 'scope', paths, reason: 'many files' },
      })
    );
    const [item] = h.feed.list();
    expect(item.summary).toBe(
      'agent asked to edit outside its scope: a.ts, b.ts, c.ts +2 more'
    );
    expect(item.paths).toEqual(paths);
  });

  it('leaves out blocking messages that ask no human question', () => {
    h.runs.push(runMeta('r-1'));
    h.gates.push(
      gate('m-handoff', { from: 'run:r-1', kind: 'handoff' }),
      gate('m-fyi', { from: 'run:r-1', blocking: false })
    );
    expect(h.feed.list()).toEqual([]);
  });

  it('orders open items longest-waiting first', () => {
    const run = runMeta('r-1');
    h.runs.push(run);
    h.gates.push(
      runQuestion('m-newer', run.id, 'second', { createdAt: ago(5_000) }),
      runQuestion('m-older', run.id, 'first', { createdAt: ago(10_000) })
    );

    expect(h.feed.list().map((item) => item.id)).toEqual([
      'question:m-older',
      'question:m-newer',
    ]);
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

  // Two ways a dead run is somebody else's problem: a resume already picked its
  // work up, or it was a review run, whose dead end the capped fix-loop item
  // already stands for. Either way the feed must not also demand a human.
  it('leaves a superseded or review run out of the stalled set', () => {
    h.runs.push(
      // Failed, but a later run resumed from it — the successor is the live one.
      runMeta('r-dead', { state: 'failed' }),
      runMeta('r-heir', { state: 'running', resumedFrom: 'r-dead' }),
      // Same, for the dirty flavour the orchestrator's own guard covers.
      runMeta('r-dirty', { state: 'interrupted-dirty' }),
      runMeta('r-dirty-heir', {
        state: 'running',
        resumedFrom: 'r-dirty',
      }),
      // A review run that failed: the fix loop reports this, not the feed.
      runMeta('r-review', { state: 'failed', kind: 'review' }),
      // The control: nothing resumed it, so it is still a human's problem.
      runMeta('r-orphaned', { state: 'failed' })
    );

    expect(byKind(h.feed.list(), 'run-stalled').map((i) => i.runId)).toEqual([
      'r-orphaned',
    ]);
  });

  // A discarded base normally outranks everything, but not supersession: the
  // successor inherits the base problem, so flagging the dead run too would
  // just put a row in front of a human that they cannot act on.
  it('leaves a superseded run out even when its base was discarded', () => {
    h.runs.push(
      runMeta('r-dead', { state: 'failed', baseDiscarded: true }),
      runMeta('r-heir', { state: 'running', resumedFrom: 'r-dead' })
    );
    expect(byKind(h.feed.list(), 'run-stalled')).toEqual([]);
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
    h.gates.push(runQuestion('m-q', run.id, 'Which database?'));
    expect(h.feed.list()).toHaveLength(1);

    // Answered: the engine no longer lists it among the open gates.
    h.gates.splice(0);
    h.setNow(T0 + 1_000);
    expect(h.feed.list()).toHaveLength(0);

    const withResolved = h.feed.list({ includeResolved: true });
    expect(withResolved).toHaveLength(1);
    expect(withResolved[0].state).toBe('resolved');
    expect(withResolved[0].resolvedAt).toBe(new Date(T0 + 1_000).toISOString());
  });

  it('keeps counting a resolved item age from when it started waiting', () => {
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
    h.gates.push(runQuestion('m-q', run.id, 'Which database?'));
    h.feed.list();
    h.gates.splice(0);
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

  it('broadcasts decisions.changed when a new gate is stored', () => {
    const stop = h.feed.start();
    const seen = capture(h.events);
    const run = runMeta('r-1');
    h.runs.push(run);
    const question = runQuestion('m-q', run.id, 'Which database?');
    h.gates.push(question);

    h.events.broadcast({ type: 'message.new', message: question });
    expect(seen).toHaveLength(1);
    stop();
  });

  it('broadcasts when a delivery change leaves a gate answered', () => {
    const run = runMeta('r-1');
    h.runs.push(run);
    h.gates.push(runQuestion('m-q', run.id, 'Which database?'));
    const stop = h.feed.start();
    const seen = capture(h.events);

    h.gates.splice(0);
    h.events.broadcast({
      type: 'delivery.changed',
      deliveryId: 'd-1',
      messageId: 'm-q',
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
    h.gates.push(runQuestion('m-q', run.id, 'Which database?'));

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
    const question = runQuestion('m-q', run.id, 'Which database?');
    h.gates.push(question);

    // The poll lands between the store write and the event it triggers.
    h.feed.list();

    h.events.broadcast({ type: 'message.new', message: question });
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
    const question = runQuestion('m-q', run.id, 'Which database?');
    h.gates.push(question);
    h.events.broadcast({ type: 'message.new', message: question });
    expect(seen).toHaveLength(0);
  });
});

describe('DecisionFeed policy seam', () => {
  it('classifies every item as blocking by default', () => {
    h.runs.push(runMeta('r-1', { state: 'failed' }));
    expect(h.feed.list().map((item) => item.disposition)).toEqual(['blocking']);
    expect(h.feed.list({ disposition: 'blocking' })).toHaveLength(1);
    expect(h.feed.list({ disposition: 'recorded' })).toEqual([]);
  });

  it('filters on the disposition an injected policy assigns', () => {
    const withPolicy = harness((item) =>
      item.kind === 'run-stalled' ? 'recorded' : 'blocking'
    );
    withPolicy.runs.push(runMeta('r-1', { state: 'failed' }));
    withPolicy.gates.push(runQuestion('m-q', 'r-1', 'Which database?'));

    expect(
      withPolicy.feed.list({ disposition: 'blocking' }).map((i) => i.kind)
    ).toEqual(['question']);
    expect(
      withPolicy.feed.list({ disposition: 'recorded' }).map((i) => i.kind)
    ).toEqual(['run-stalled']);
    expect(withPolicy.feed.list()).toHaveLength(2);
  });
});

// The floor in the feed: a classifier that records everything (the most
// permissive policy expressible) still cannot demote a floor item, because
// list() pins the disposition before the classifier is consulted.
describe('DecisionFeed irreversibility floor', () => {
  const recordEverything: DecisionPolicy = () => 'recorded';

  it('keeps a floor command approval blocking under a record-everything policy', () => {
    const h = harness(recordEverything);
    h.runs.push(runMeta('r-1'));
    h.gates.push(
      approvalGate('m-force', 'r-1', 'req-force', {
        command: 'git push --force origin main',
      }),
      approvalGate('m-publish', 'r-1', 'req-publish', {
        command: 'npm publish',
      }),
      approvalGate('m-ls', 'r-1', 'req-ls', { command: 'ls' })
    );
    const byId = new Map(h.feed.list().map((item) => [item.id, item]));
    expect(byId.get('approval:m-force')).toMatchObject({
      floor: 'force-push',
      disposition: 'blocking',
    });
    expect(byId.get('approval:m-publish')).toMatchObject({
      floor: 'publish',
      disposition: 'blocking',
    });
    expect(byId.get('approval:m-ls')).toMatchObject({
      disposition: 'recorded',
    });
    expect(byId.get('approval:m-ls')?.floor).toBeUndefined();
    expect(h.feed.list({ disposition: 'blocking' })).toHaveLength(2);
  });

  it('names the hold of a flagged gate whose preview was cut from the parked call', () => {
    const h = harness(recordEverything);
    const command = `${' '.repeat(9000)}; git push --force origin main`;
    h.runs.push(runMeta('r-1', { state: 'awaiting-approval' }));
    h.pending.set('r-1', { requestId: 'req-1', input: { command } });
    h.gates.push(
      gate('m-cut', {
        data: toolApprovalGateData(
          { runId: 'r-1' },
          { requestId: 'req-1', toolName: 'Bash', input: { command } }
        ),
      })
    );
    const [item] = h.feed.list();
    expect(item).toMatchObject({
      floor: 'force-push',
      disposition: 'blocking',
    });
  });

  it('keeps a flagged gate held when neither its parked call nor its preview names the check', () => {
    const h = harness(recordEverything);
    const command = `${' '.repeat(9000)}; git push --force origin main`;
    // The parked call has settled, and the cut preview stops before the push.
    h.runs.push(runMeta('r-1', { state: 'running' }));
    h.gates.push(
      gate('m-cut', {
        data: toolApprovalGateData(
          { runId: 'r-1' },
          { requestId: 'req-1', toolName: 'Bash', input: { command } }
        ),
      })
    );
    expect(h.feed.list()[0]).toMatchObject({
      floor: 'unknown',
      disposition: 'blocking',
    });
  });

  it("holds an overseer's floor call whose preview was cut, and names it from the conversation", () => {
    const command = `git push --force origin main ${'#'.repeat(9000)}`;
    const data = toolApprovalGateData(
      { conversation: 'c-1' },
      { requestId: 'req-1', toolName: 'Bash', input: { command } }
    );
    expect(previewToolInput({ command }).truncated).toBe(true);
    const feed = (conversationApprovalInput?: () => unknown) =>
      new DecisionFeed({
        orchestrator: {
          list: () => [],
          pendingApprovalFor: () => undefined,
        },
        openGates: () => [gate('m-o', { data })],
        fixLoopStore: { list: () => [] },
        cache: { get: () => null },
        events: new EventBus(),
        conversationApprovalInput,
        policy: recordEverything,
      });
    // From the parked call's full input, and from the preview when it is gone.
    expect(feed(() => ({ command })).list()[0]).toMatchObject({
      floor: 'force-push',
      disposition: 'blocking',
    });
    expect(feed().list()[0]?.floor).toBe('force-push');
  });

  it('never holds a gate the raiser did not flag, whatever its preview says', () => {
    const h = harness(recordEverything);
    h.runs.push(runMeta('r-1'));
    h.gates.push(
      gate('m-x', {
        data: {
          type: 'tool-approval',
          requestId: 'req-1',
          runId: 'r-1',
          tool: 'Bash',
          input: { command: 'git push --force origin main' },
          floor: false,
        },
      })
    );
    expect(h.feed.list()[0]?.floor).toBeUndefined();
  });

  it('ignores a different call parked on the same run', () => {
    const h = harness(recordEverything);
    h.runs.push(runMeta('r-1', { state: 'awaiting-approval' }));
    h.pending.set('r-1', {
      requestId: 'req-newer',
      input: { command: 'git push --force origin main' },
    });
    h.gates.push(approvalGate('m-ls', 'r-1', 'req-older', { command: 'ls' }));
    const [item] = h.feed.list();
    expect(item.floor).toBeUndefined();
    expect(item.disposition).toBe('recorded');
  });

  it('keeps a budget-exhausted run and a capped loop blocking under the same policy', () => {
    const h = harness(recordEverything);
    h.runs.push(
      runMeta('r-broke', {
        state: 'failed' as RunState,
        error: 'run hit its cost budget before the agent finished',
      }),
      runMeta('r-crashed', { state: 'failed' as RunState, error: 'boom' })
    );
    h.loops.push(cappedLoop('t-capped'));
    const byId = new Map(h.feed.list().map((item) => [item.id, item]));
    expect(byId.get('run-stalled:r-broke')).toMatchObject({
      floor: 'budget-cap',
      disposition: 'blocking',
    });
    expect(byId.get('run-stalled:r-crashed')).toMatchObject({
      disposition: 'recorded',
    });
    expect(byId.get('fix-loop-capped:t-capped')).toMatchObject({
      floor: 'finding-ruling',
      disposition: 'blocking',
    });
  });
});

describe('DecisionFeed ownership', () => {
  it('stamps an item with the human whose run it came from', () => {
    // The "whose attention" axis: Ada's parked approval is visible to
    // everyone, but it is Ada's to answer.
    const adas = runMeta('r-ada', {
      state: 'awaiting-approval',
      dispatchedBy: 'human:ada',
    });
    h.runs.push(adas);
    h.gates.push(
      approvalGate('m-a', adas.id, 'req-1', { command: 'ls' }),
      runQuestion('m-q', adas.id, 'Which way?')
    );

    const items = h.feed.list();
    expect(items.map((item) => item.owner)).toEqual(['human:ada', 'human:ada']);
  });

  it("leaves an item with no dispatcher ownerless, so everyone's", () => {
    const auto = runMeta('r-auto', { state: 'awaiting-approval' });
    h.runs.push(auto);
    h.gates.push(approvalGate('m-a', auto.id, 'req-2', {}));
    h.titles.set('t-99', 'Capped task');
    h.loops.push(cappedLoop('t-99'));

    for (const item of h.feed.list()) {
      expect(item.owner).toBeUndefined();
      expect('owner' in item).toBe(false);
    }
  });
});
