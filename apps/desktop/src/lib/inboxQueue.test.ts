import type { RepoPr, RunMeta, RunQuestion } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import type { InboxInput } from './inboxQueue';
import { buildInbox } from './inboxQueue';

function run(over: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r-1',
    taskId: 't-1',
    taskTitle: 'Do the thing',
    executor: 'claude',
    state: 'finished',
    branch: 'dispatch/t-1',
    baseBranch: 'main',
    worktreePath: '/tmp/wt',
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    ...over,
  } as RunMeta;
}

function question(over: Partial<RunQuestion> = {}): RunQuestion {
  return {
    id: 'q-1',
    runId: 'r-1',
    question: 'Which way?',
    options: [],
    askedAt: '2026-08-04T00:30:00.000Z',
    answer: null,
    ...over,
  } as RunQuestion;
}

function input(over: Partial<InboxInput> = {}): InboxInput {
  return {
    runs: [],
    tasks: [],
    epics: [],
    repoPrs: [],
    mergeQueue: null,
    pendingApprovals: new Map(),
    openQuestions: new Map(),
    fixLoops: new Map(),
    ...over,
  };
}

function sectionStates(data: ReturnType<typeof buildInbox>): string[] {
  return data.sections.map((s) => s.state);
}

describe('buildInbox', () => {
  test('a finished, un-reviewed run lands in a review section', () => {
    const data = buildInbox(input({ runs: [run()] }));
    expect(sectionStates(data)).toEqual(['review']);
    expect(data.sections[0].rows.map((r) => r.runId)).toEqual(['r-1']);
    expect(data.total).toBe(1);
  });

  test('a run awaiting approval lands in approve', () => {
    const data = buildInbox(
      input({ runs: [run({ state: 'awaiting-approval' })] })
    );
    expect(sectionStates(data)).toEqual(['approve']);
  });

  test('a run blocked on an unanswered question lands in answer', () => {
    const data = buildInbox(
      input({
        runs: [run({ state: 'running' })],
        openQuestions: new Map([['r-1', [question()]]]),
      })
    );
    expect(sectionStates(data)).toEqual(['answer']);
  });

  test('a failed run lands in failed — the old rules dropped these', () => {
    const data = buildInbox(
      input({ runs: [run({ state: 'failed', error: 'boom' })] })
    );
    expect(sectionStates(data)).toEqual(['failed']);
    expect(data.sections[0].rows[0].attention?.reason).toBe('boom');
  });

  test('one row per task: only the newest settled round speaks for it', () => {
    const data = buildInbox(
      input({
        runs: [
          run({ id: 'r-old', createdAt: '2026-08-01T00:00:00.000Z' }),
          run({ id: 'r-new', createdAt: '2026-08-03T00:00:00.000Z' }),
        ],
      })
    );
    expect(data.total).toBe(1);
    expect(data.sections[0].rows.map((r) => r.runId)).toEqual(['r-new']);
  });

  test('a live run suppresses its task’s settled review rows', () => {
    const data = buildInbox(
      input({
        runs: [
          run({ id: 'r-reviewed', createdAt: '2026-08-01T00:00:00.000Z' }),
          run({
            id: 'r-live',
            state: 'running',
            createdAt: '2026-08-03T00:00:00.000Z',
          }),
        ],
      })
    );
    // The live run itself is calm (machine tier), so nothing is urgent at all.
    expect(data.total).toBe(0);
  });

  test('a reviewed run leaves the urgent sections for ready-to-land', () => {
    const data = buildInbox(
      input({ runs: [run({ reviewedAt: '2026-08-04T01:00:00.000Z' })] })
    );
    expect(data.sections).toHaveLength(0);
    expect(data.readyToLand.map((r) => r.runId)).toEqual(['r-1']);
    expect(data.total).toBe(1);
  });

  test('a calm running run appears nowhere', () => {
    const data = buildInbox(input({ runs: [run({ state: 'running' })] }));
    expect(data.total).toBe(0);
  });

  test('an unclaimed repo PR lands in prs; a run-claimed one does not', () => {
    const claimed = {
      number: 7,
      url: 'https://github.com/x/y/pull/7',
      title: 'Claimed',
      updatedAt: '2026-08-04T00:00:00.000Z',
    } as RepoPr;
    const standalone = {
      number: 9,
      url: 'https://github.com/x/y/pull/9',
      title: 'Standalone',
      updatedAt: '2026-08-04T00:00:00.000Z',
    } as RepoPr;
    const data = buildInbox(
      input({
        runs: [run({ prUrl: claimed.url })],
        repoPrs: [claimed, standalone],
      })
    );
    expect(data.prs.map((pr) => pr.number)).toEqual([9]);
    // review row for the claimed run + one standalone PR.
    expect(data.total).toBe(2);
  });
});

describe('readyToLand', () => {
  test('a reviewed, unlanded run surfaces; queued/PR/landed-task ones do not', () => {
    const reviewed = (over: Partial<RunMeta>) =>
      run({ reviewedAt: '2026-08-04T01:00:00.000Z', ...over });
    const data = buildInbox(
      input({
        runs: [
          reviewed({ id: 'r-land', taskId: 't-land' }),
          reviewed({
            id: 'r-queued',
            taskId: 't-queued',
          }),
          reviewed({
            id: 'r-pr',
            taskId: 't-pr',
            prUrl: 'https://github.com/x/y/pull/3',
          }),
        ],
        mergeQueue: {
          entries: [{ runId: 'r-queued', state: 'queued' }],
        } as unknown as InboxInput['mergeQueue'],
      })
    );
    expect(data.readyToLand.map((r) => r.runId)).toEqual(['r-land']);
    expect(data.readyToLand[0].activity).toBe('Reviewed, not landed');
    // r-land + the PR-backed run's own review row is gone (reviewed), and the
    // claimed PR isn't in repoPrs here — so the total is just the one row.
    expect(data.total).toBe(1);
  });

  test('only the newest reviewed run speaks for a task', () => {
    const data = buildInbox(
      input({
        runs: [
          run({
            id: 'r-old',
            reviewedAt: '2026-08-01T01:00:00.000Z',
            createdAt: '2026-08-01T00:00:00.000Z',
          }),
          run({
            id: 'r-new',
            reviewedAt: '2026-08-03T01:00:00.000Z',
            createdAt: '2026-08-03T00:00:00.000Z',
          }),
        ],
      })
    );
    expect(data.readyToLand.map((r) => r.runId)).toEqual(['r-new']);
  });
});
