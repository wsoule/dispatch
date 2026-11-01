import { describe, expect, test } from 'bun:test';

import type {
  LinearBulkOutcome,
  LinearStatus,
  LinearSyncSummary,
} from '../src/apiClient.js';
import { DaemonUnreachableError } from '../src/apiClient.js';
import { followLinearBulk, followLinearPass } from '../src/commands/linear.js';
import { CliError } from '../src/context.js';

const T0 = Date.parse('2026-10-25T10:00:00.000Z');

function summary(at: number, extra: Partial<LinearSyncSummary> = {}) {
  return {
    at: new Date(at).toISOString(),
    pulled: 0,
    pushed: 0,
    created: 0,
    createdIssues: 1,
    conflicts: 0,
    errors: [],
    rateLimited: false,
    ...extra,
  };
}

function status(extra: Partial<LinearStatus> = {}): LinearStatus {
  return {
    enabled: true,
    connected: true,
    keySource: 'project',
    teamId: 'team',
    direction: 'both',
    intervalSec: 300,
    bootstrappedAt: 'b',
    lastSyncAt: null,
    lastError: null,
    lastSummary: null,
    syncing: false,
    ...extra,
  };
}

// A status reader answering the queued statuses in turn, then the last forever.
function statuses(...queue: (LinearStatus | Error)[]) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    linearStatus: () => {
      const next = queue[Math.min(calls, queue.length - 1)];
      calls++;
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    },
  };
}

const fast = { intervalMs: 5, now: () => T0 };

describe('followLinearPass', () => {
  test('a summary the request answered is returned with no polling', async () => {
    const api = statuses(status());
    const done = summary(T0);
    expect(await followLinearPass(api, () => Promise.resolve(done), fast)).toBe(
      done
    );
    expect(api.calls).toBe(0);
  });

  test('after a cut request, follows status to the fresh summary', async () => {
    const fresh = summary(T0 + 200);
    const api = statuses(
      status({
        syncing: true,
        progress: { phase: 'issues', done: 10, total: 100 },
      }),
      status({
        syncing: true,
        progress: { phase: 'issues', done: 12, total: 100 },
      }),
      status({
        syncing: true,
        progress: { phase: 'issues', done: 55, total: 100 },
      }),
      status({ syncing: false, lastSummary: fresh })
    );
    const lines: string[] = [];
    const result = await followLinearPass(
      api,
      () => Promise.reject(new DaemonUnreachableError('timed out')),
      { ...fast, onProgress: (l) => lines.push(l) }
    );
    expect(result).toEqual(fresh);
    // 10 and 12 of 100 share a tenth, so only one line for them.
    expect(lines).toEqual([
      'Fetching issues… 10 of 100',
      'Fetching issues… 55 of 100',
    ]);
  });

  test('reports progress while the request is still in flight', async () => {
    const api = statuses(
      status({
        syncing: true,
        progress: { phase: 'containers', done: 3, total: null },
      })
    );
    const lines: string[] = [];
    const done = summary(T0);
    const result = await followLinearPass(
      api,
      () => new Promise((resolve) => setTimeout(() => resolve(done), 40)),
      { ...fast, onProgress: (l) => lines.push(l) }
    );
    expect(result).toBe(done);
    expect(lines).toEqual(['Reading projects… 3']);
  });

  test('another failure from the request is rethrown as is', async () => {
    const api = statuses(status());
    const err = new CliError('no Linear API key configured');
    await expect(
      followLinearPass(api, () => Promise.reject(err), fast)
    ).rejects.toBe(err);
    expect(api.calls).toBe(0);
  });

  test('a status call that fails is rethrown', async () => {
    const gone = new DaemonUnreachableError('dispatchd stopped responding');
    const api = statuses(gone);
    await expect(
      followLinearPass(
        api,
        () => Promise.reject(new DaemonUnreachableError('timed out')),
        fast
      )
    ).rejects.toBe(gone);
  });

  test('a stale summary is never returned', async () => {
    const api = statuses(
      status({ syncing: false, lastSummary: summary(T0 - 60_000) })
    );
    const err = await followLinearPass(
      api,
      () => Promise.reject(new DaemonUnreachableError('timed out')),
      fast
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as Error).message).toContain('dispatch linear status');
  });

  test('keeps its own pass’s summary when a pass queued behind it ends last', async () => {
    const ours = summary(T0 + 200, { createdIssues: 40 });
    const queued = summary(T0 + 90_000, { createdIssues: 0, pushed: 1 });
    const api = statuses(
      status({ syncing: true }),
      // Ours ended; a push a task edit queued behind it is running.
      status({ syncing: true, lastSummary: ours }),
      status({ syncing: false, lastSummary: queued })
    );
    const result = await followLinearPass(
      api,
      () => Promise.reject(new DaemonUnreachableError('timed out')),
      fast
    );
    expect(result).toEqual(ours);
  });

  test('a sync that joined a pass begun earlier takes that pass’s summary', async () => {
    const before = summary(T0 - 600_000);
    const joined = summary(T0 - 30_000, { pulled: 5 });
    const api = statuses(
      status({ syncing: true, lastSummary: before }),
      status({ syncing: false, lastSummary: joined })
    );
    const result = await followLinearPass(
      api,
      () => Promise.reject(new DaemonUnreachableError('timed out')),
      { ...fast, joins: true }
    );
    expect(result).toEqual(joined);
  });

  test('a sync that joined a pass queued behind another takes the queued one’s summary', async () => {
    const before = summary(T0 - 600_000);
    const ahead = summary(T0 - 120_000, {
      createdIssues: 40,
      errors: ['issue limit'],
    });
    const joined = summary(T0 + 70_000, { pulled: 2 });
    const api = statuses(
      status({ syncing: true, lastSummary: before }),
      // The export ahead of it ended; the joined pass is running.
      status({ syncing: true, lastSummary: ahead }),
      status({ syncing: false, lastSummary: joined })
    );
    const result = await followLinearPass(
      api,
      () => Promise.reject(new DaemonUnreachableError('timed out')),
      { ...fast, joins: true }
    );
    expect(result).toEqual(joined);
  });

  test('a sync whose joined pass ended before the first poll takes its summary', async () => {
    const joined = summary(T0 - 30_000, { pulled: 5 });
    const api = statuses(status({ syncing: false, lastSummary: joined }));
    const result = await followLinearPass(
      api,
      () => Promise.reject(new DaemonUnreachableError('timed out')),
      { ...fast, joins: true }
    );
    expect(result).toEqual(joined);
  });

  test('tags the request and asks status for that tag', async () => {
    const asked: (string | undefined)[] = [];
    const answered = summary(T0 + 200);
    const api = {
      linearStatus: (request?: string) => {
        asked.push(request);
        return Promise.resolve(status({ syncing: false, answered }));
      },
    };
    let sent: string | undefined;
    const result = await followLinearPass(
      api,
      (request) => {
        sent = request;
        return Promise.reject(new DaemonUnreachableError('timed out'));
      },
      { ...fast, request: 'req-1' }
    );
    expect(sent).toBe('req-1');
    expect(asked).toEqual(['req-1']);
    expect(result).toBe(answered);
  });

  test('a joined pass’s answer wins over a later pass queued behind it', async () => {
    const exported = summary(T0 - 120_000, { errors: ['issue limit'] });
    const push = summary(T0 + 90_000, { pushed: 1 });
    const api = statuses(
      status({ syncing: true, answered: null }),
      // The export it joined ended; a push queued after the request runs.
      status({ syncing: true, lastSummary: exported, answered: exported }),
      status({ syncing: false, lastSummary: push, answered: exported })
    );
    const result = await followLinearPass(
      api,
      () => Promise.reject(new DaemonUnreachableError('timed out')),
      { ...fast, joins: true }
    );
    expect(result).toEqual(exported);
  });

  test('with passes queued ahead, the answer is the tail it joined', async () => {
    const p1 = summary(T0 + 10_000, { pushed: 1 });
    const p2 = summary(T0 + 20_000, { pushed: 2 });
    const api = statuses(
      status({ syncing: true, lastSummary: p1, answered: null }),
      status({ syncing: false, lastSummary: p2, answered: p2 })
    );
    const result = await followLinearPass(
      api,
      () => Promise.reject(new DaemonUnreachableError('timed out')),
      { ...fast, joins: true }
    );
    expect(result).toEqual(p2);
  });

  test('a tagged pass that ended unanswered is an error', async () => {
    const api = statuses(
      status({ syncing: false, lastSummary: summary(T0 + 500), answered: null })
    );
    const err = await followLinearPass(
      api,
      () => Promise.reject(new DaemonUnreachableError('timed out')),
      fast
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as Error).message).toContain('dispatch linear status');
  });

  test('at the deadline it points at dispatch linear status', async () => {
    let clock = T0;
    const api = statuses(status({ syncing: true }));
    const err = await followLinearPass(
      api,
      () => Promise.reject(new DaemonUnreachableError('timed out')),
      {
        intervalMs: 1,
        timeoutMs: 1000,
        now: () => (clock += 400),
      }
    ).catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      'the Linear pass is still running in dispatchd; check it with: dispatch linear status'
    );
  });
});

describe('followLinearBulk', () => {
  const STARTED = '2026-10-25T10:00:01.000Z';
  const outcome: LinearBulkOutcome = {
    action: 'export',
    startedAt: STARTED,
    at: '2026-10-25T10:02:00.000Z',
    scope: 'open',
    candidates: 3,
    done: 3,
    remaining: 0,
    halted: null,
    errors: [],
  };

  test('nothing to send answers null without polling', async () => {
    const api = statuses(status());
    expect(
      await followLinearBulk(
        api,
        () => Promise.resolve({ started: false, candidates: 0 }),
        fast
      )
    ).toBeNull();
    expect(api.calls).toBe(0);
  });

  test('follows status until the outcome with its startedAt lands', async () => {
    const older = { ...outcome, startedAt: 'earlier' };
    const api = statuses(
      status({
        syncing: true,
        running: { action: 'export', startedAt: STARTED },
        lastExport: older,
        progress: { phase: 'creating', done: 1, total: 3, action: 'export' },
      }),
      status({ syncing: false, running: null, lastExport: outcome })
    );
    const lines: string[] = [];
    const result = await followLinearBulk(
      api,
      () =>
        Promise.resolve({ started: true, candidates: 3, startedAt: STARTED }),
      { ...fast, onProgress: (l) => lines.push(l) }
    );
    expect(result).toEqual(outcome);
    expect(lines).toEqual(['Creating in Linear… 1 of 3']);
  });

  test('an archive outcome is read from lastArchive', async () => {
    const archived = { ...outcome, action: 'archive' as const };
    const api = statuses(status({ running: null, lastArchive: archived }));
    expect(
      await followLinearBulk(
        api,
        () =>
          Promise.resolve({ started: true, candidates: 3, startedAt: STARTED }),
        fast
      )
    ).toEqual(archived);
  });

  test('a run that ended without its outcome is an error', async () => {
    const api = statuses(status({ running: null, lastExport: null }));
    const err = await followLinearBulk(
      api,
      () =>
        Promise.resolve({ started: true, candidates: 3, startedAt: STARTED }),
      fast
    ).catch((e: unknown) => e);
    expect((err as Error).message).toContain('dispatch linear status');
  });
});
