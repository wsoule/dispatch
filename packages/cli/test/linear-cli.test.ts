import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  LinearBulkOutcome,
  LinearCapacity,
  LinearCoverage,
  LinearStatus,
  LinearSyncSummary,
} from '../src/apiClient.js';
import { daemonFilePath } from '../src/commands/daemon.js';
import type { CliContext } from '../src/context.js';
import { makeProgram } from '../src/program.js';

// `dispatch linear` against a fake dispatchd: which routes each command
// calls, on which token, with which body, and what it prints.

const AGENT_TOKEN = 'agent-token';
const APP_TOKEN = 'app-token';
const STARTED = '2026-10-25T10:00:01.000Z';

const BASE_STATUS: LinearStatus = {
  enabled: true,
  connected: true,
  keySource: 'project',
  teamId: 'abcdef1234567890',
  teamIds: ['abcdef1234567890'],
  direction: 'both',
  intervalSec: 300,
  bootstrappedAt: '2026-10-01T00:00:00.000Z',
  lastSyncAt: '2026-10-25T09:00:00.000Z',
  lastError: null,
  lastSummary: null,
  syncing: false,
  progress: null,
  webhook: {
    state: 'polling',
    url: null,
    lastDeliveryAt: null,
    error: null,
    pollSec: 300,
  },
  capacity: null,
  coverage: {
    total: 30,
    linked: 20,
    notLinked: 10,
    heldBack: 10,
    queued: 0,
    failed: 0,
    excluded: 0,
  },
  running: null,
  lastExport: null,
  lastArchive: null,
};

const CAPACITY: LinearCapacity = {
  teams: [
    {
      id: 'abcdef1234567890',
      key: 'DIS',
      name: 'Dispatch',
      active: 240,
      completed: 120,
      canceled: 23,
    },
  ],
  active: 240,
  activeScope: 'workspace',
  limit: 250,
  limitSource: 'plan',
  plan: 'free',
  limitHitAt: null,
  truncated: false,
  checkedAt: '2026-10-25T10:00:00.000Z',
};

const PREVIEW = {
  open: 20,
  all: 30,
  allArchiveFinished: 35,
  finished: 10,
  archived: 5,
  derived: 0,
  containers: 0,
};

function summary(extra: Partial<LinearSyncSummary> = {}): LinearSyncSummary {
  return {
    at: new Date().toISOString(),
    pulled: 0,
    pushed: 0,
    created: 0,
    createdIssues: 2,
    conflicts: 0,
    errors: [],
    rateLimited: false,
    ...extra,
  };
}

function outcome(
  action: LinearBulkOutcome['action'],
  extra: Partial<LinearBulkOutcome> = {}
): LinearBulkOutcome {
  return {
    action,
    startedAt: STARTED,
    at: '2026-10-25T10:01:00.000Z',
    candidates: 3,
    done: 3,
    remaining: 0,
    halted: null,
    errors: [],
    ...extra,
  };
}

function coverageWith(n: number): LinearCoverage {
  return {
    total: 20 + n,
    linked: 20,
    notLinked: n,
    excluded: { derived: 0 },
    byEntity: { issue: 20, project: 0, milestone: 0, initiative: 0 },
    counts: { 'held-back': n - 1, failed: 1 },
    unlinked: Array.from({ length: n }, (_, i) => ({
      id: `t-${String(i).padStart(3, '0')}`,
      title: `Task ${i}`,
      kind: 'task',
      status: 'todo',
      finished: false,
      archived: false,
      reason: i === 0 ? 'failed' : 'held-back',
      attempts: i === 0 ? 2 : 0,
      lastError: i === 0 ? 'label refused' : null,
      lastAttemptAt: null,
      retryAt: null,
    })),
  };
}

let root: string;
let fakeHome: string;
let lines: string[];
let ctx: CliContext;
let server: ReturnType<typeof Bun.serve>;
let seen: { method: string; path: string; auth: string | null; body: string }[];
let status: LinearStatus;
// Per test: what a POST answers, keyed `METHOD /path`.
let answers: Map<string, () => Response>;
const originalHome = process.env.DISPATCH_HOME;
const originalToken = process.env.DISPATCH_APP_TOKEN;

// The bulk routes answer 202 and leave the outcome where status reports it.
function bulkStart(
  field: 'lastExport' | 'lastArchive',
  done: LinearBulkOutcome
) {
  return () => {
    status = { ...status, [field]: done };
    return Response.json(
      { started: true, candidates: done.candidates, startedAt: STARTED },
      { status: 202 }
    );
  };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-linear-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-linear-'));
  process.env.DISPATCH_HOME = fakeHome;
  delete process.env.DISPATCH_APP_TOKEN;
  lines = [];
  ctx = { cwd: root, log: (l) => lines.push(l) };
  await makeProgram(ctx).parseAsync(['init'], { from: 'user' });
  lines = [];
  seen = [];
  status = structuredClone(BASE_STATUS);
  answers = new Map([
    ['POST /api/linear/sync', () => Response.json(summary())],
    ['POST /api/linear/import', () => Response.json(summary({ created: 4 }))],
    ['GET /api/linear/export', () => Response.json(PREVIEW)],
    ['POST /api/linear/export', bulkStart('lastExport', outcome('export'))],
    ['POST /api/linear/retry', bulkStart('lastExport', outcome('retry'))],
    ['POST /api/linear/forget', () => Response.json({ forgotten: 1 })],
    ['GET /api/linear/coverage', () => Response.json(coverageWith(3))],
    ['GET /api/linear/capacity', () => Response.json(CAPACITY)],
    [
      'POST /api/linear/archive-closed',
      bulkStart(
        'lastArchive',
        outcome('archive', { candidates: 120, done: 120 })
      ),
    ],
  ]);
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/api/health') return Response.json({ ok: true });
      seen.push({
        method: req.method,
        path: `${url.pathname}${url.search}`,
        auth: req.headers.get('authorization'),
        body: await req.text(),
      });
      if (url.pathname === '/api/linear/status') return Response.json(status);
      const answer = answers.get(`${req.method} ${url.pathname}`);
      if (answer !== undefined) return answer();
      return Response.json(
        { error: `not found: ${url.pathname}` },
        { status: 404 }
      );
    },
  });
  mkdirSync(join(fakeHome, '.dispatch', 'daemons'), { recursive: true });
  writeFileSync(
    daemonFilePath(root),
    JSON.stringify({
      port: server.port,
      pid: process.pid,
      rootDir: root,
      startedAt: new Date().toISOString(),
      agentToken: AGENT_TOKEN,
    })
  );
});

afterEach(() => {
  void server.stop(true);
  rmSync(root, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  if (originalToken === undefined) delete process.env.DISPATCH_APP_TOKEN;
  else process.env.DISPATCH_APP_TOKEN = originalToken;
});

function run(...args: string[]): Promise<unknown> {
  return makeProgram(ctx).parseAsync(['linear', ...args], { from: 'user' });
}

// The random id sync and import tag a request with, for status to answer.
const REQUEST_TAG = /\?request=[0-9a-f-]{36}$/;

// Requests other than the status reads every command starts with, their
// request tags dropped.
function writes() {
  return seen
    .filter((s) => s.method === 'POST')
    .map((s) => ({ ...s, path: s.path.replace(REQUEST_TAG, '') }));
}

describe('dispatch linear status', () => {
  it('is the default, and says what is not in Linear yet', async () => {
    status.bootstrappedAt = null;
    status.lastError =
      'Workspace is at its issue limit — archive closed issues or upgrade';
    status.capacity = {
      limitedAt: '2026-10-25T10:00:00.000Z',
      retryAt: new Date(Date.now() + 60_000).toISOString(),
      message: status.lastError,
      active: 250,
      limit: 250,
      limitSource: 'plan',
      plan: 'free',
      checkedAt: null,
    };
    await run();
    const text = lines.join('\n');
    expect(text).toContain('Syncing both ways with team abcdef12');
    expect(text).toContain('Stopped creating in Linear');
    expect(text).toContain('10 of 30 tasks are not in Linear');
    expect(text).toContain('Not linked yet');
    expect(seen[0]?.auth).toBe(`Bearer ${AGENT_TOKEN}`);
  });

  it('--json passes the payload through', async () => {
    await run('status', '--json');
    expect(JSON.parse(lines.join('\n'))).toEqual(status);
    lines = [];
    await run('--json');
    expect(JSON.parse(lines.join('\n'))).toEqual(status);
  });

  it('uses the app token when one is given', async () => {
    await run('status', '--token', APP_TOKEN);
    expect(seen[0]?.auth).toBe(`Bearer ${APP_TOKEN}`);
  });

  it('needs a running daemon and never starts one', async () => {
    rmSync(daemonFilePath(root));
    await expect(run('status')).rejects.toThrow(
      'no dispatchd is running for this project'
    );
    expect(seen).toEqual([]);
  });
});

describe('dispatch linear sync', () => {
  it('runs a pass and prints its counts', async () => {
    await run('sync');
    expect(writes().map((s) => `${s.path} ${s.body}`)).toEqual([
      '/api/linear/sync {}',
    ]);
    expect(lines).toContain('2 created in Linear');
  });

  it('tags the request so a cut one can find what it got', async () => {
    await run('sync');
    const sync = seen.find((s) => s.method === 'POST');
    expect(sync?.path).toMatch(REQUEST_TAG);
  });

  it('refuses while sync is off', async () => {
    status.enabled = false;
    await expect(run('sync')).rejects.toThrow('sync is off');
    expect(writes()).toEqual([]);
  });
});

describe('dispatch linear push', () => {
  it('pushes named tasks through /sync on the agent token', async () => {
    await run('push', 't-a', 't-b', 't-a');
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: '/api/linear/sync',
        auth: `Bearer ${AGENT_TOKEN}`,
        body: JSON.stringify({ taskIds: ['t-a', 't-b'] }),
      },
    ]);
    expect(lines).toContain(
      '10 tasks still not in Linear: dispatch linear coverage'
    );
  });

  it('--unlinked exports the open scope and follows it to its outcome', async () => {
    await run('push', '--unlinked');
    expect(writes().map((s) => `${s.path} ${s.body}`)).toEqual([
      '/api/linear/export {"scope":"open"}',
    ]);
    expect(lines).toContain('3 of 3 sent to Linear.');
  });

  it('--all --archive-on-arrival exports everything, archiving on arrival', async () => {
    await run('push', '--all', '--archive-on-arrival');
    expect(writes().map((s) => s.body)).toEqual([
      '{"scope":"all-archive-finished"}',
    ]);
  });

  it('--unlinked --scope all exports the all scope', async () => {
    await run('push', '--unlinked', '--scope', 'all', '--json');
    expect(writes().map((s) => s.body)).toEqual(['{"scope":"all"}']);
    expect(JSON.parse(lines.join('\n'))).toEqual(outcome('export'));
  });

  it('warns when the export will not fit under the limit', async () => {
    await run('push', '--unlinked');
    expect(lines.join('\n')).toContain(
      'Room for 10 more issues in Linear (240 of 250 active); the push stops creating at the limit. Free room first: dispatch linear archive-closed'
    );
  });

  it('a capacity read that fails never blocks the export', async () => {
    answers.set('GET /api/linear/capacity', () =>
      Response.json({ error: 'linear rate limited' }, { status: 429 })
    );
    await run('push', '--unlinked');
    expect(writes().map((s) => s.path)).toEqual(['/api/linear/export']);
    expect(lines.join('\n')).not.toContain('Room for');
  });

  it('refuses bad combinations before any request', async () => {
    for (const args of [
      ['--all', 't-a'],
      ['--unlinked', '--scope', 'x'],
      ['--unlinked', '--archive-on-arrival'],
      ['T-A'],
      [],
    ]) {
      await expect(run('push', ...args)).rejects.toThrow();
    }
    expect(seen).toEqual([]);
  });

  it('refuses on a pull-only link', async () => {
    status.direction = 'pull';
    await expect(run('push', '--unlinked')).rejects.toThrow(
      'Linear sync is pull-only here (linear.direction: pull), so nothing is pushed'
    );
    expect(writes()).toEqual([]);
  });

  it('prints a halted pass, then fails with the limit', async () => {
    answers.set('POST /api/linear/sync', () =>
      Response.json(
        summary({
          createdIssues: 1,
          usageLimited: true,
          errors: ['usage limit exceeded'],
        })
      )
    );
    await expect(run('push', 't-a', 't-b')).rejects.toThrow(
      'Workspace is at its issue limit'
    );
    expect(lines).toContain('1 created in Linear');
    expect(lines).toContain('Error: usage limit exceeded');
  });

  it('a halted export fails with the limit too', async () => {
    answers.set(
      'POST /api/linear/export',
      bulkStart(
        'lastExport',
        outcome('export', {
          done: 1,
          remaining: 2,
          halted: 'usage-limit',
          errors: ['usage limit exceeded (x2)'],
        })
      )
    );
    await expect(run('push', '--all')).rejects.toThrow(
      'Workspace is at its issue limit'
    );
    expect(lines).toContain('1 of 3 sent to Linear.');
  });

  it('--dry-run reads the preview and sends nothing', async () => {
    await run('push', '--unlinked', '--dry-run');
    await run('push', '--dry-run');
    expect(writes()).toEqual([]);
    const text = lines.join('\n');
    expect(text).toContain('Would send 20 open tasks to Linear.');
    expect(text).toContain('--archive-on-arrival   35 tasks');
  });

  it('--failed retries every queued create', async () => {
    await run('push', '--failed');
    expect(writes().map((s) => `${s.path} ${s.body}`)).toEqual([
      '/api/linear/retry {}',
    ]);
    expect(lines).toContain('3 of 3 sent to Linear.');
  });

  it('--failed with nothing queued says so', async () => {
    answers.set('POST /api/linear/retry', () =>
      Response.json({ started: false, candidates: 0 })
    );
    await run('push', '--failed');
    expect(lines).toContain('Nothing failed or queued.');
  });

  it('--forget stops retrying the named tasks', async () => {
    await run('push', '--forget', 't-a', 't-b');
    expect(writes().map((s) => `${s.path} ${s.body}`)).toEqual([
      '/api/linear/forget {"taskIds":["t-a","t-b"]}',
    ]);
    expect(lines.join('\n')).toContain('Stopped retrying 1 task(s)');
  });
});

describe('dispatch linear import', () => {
  it('runs the import and prints its counts', async () => {
    await run('import');
    expect(writes().map((s) => s.path)).toEqual(['/api/linear/import']);
    expect(lines.join('\n')).toContain('4 created locally');
  });
});

describe('dispatch linear coverage', () => {
  it('cuts the table at 50 rows without --all', async () => {
    answers.set('GET /api/linear/coverage', () =>
      Response.json(coverageWith(60))
    );
    await run('coverage');
    let text = lines.join('\n');
    expect(text).toContain('20 of 80 tasks are in Linear (25%).');
    expect(text).toContain('... and 10 more (--all lists every one)');
    expect(text).toContain('label refused');
    lines = [];
    await run('coverage', '--all');
    text = lines.join('\n');
    expect(text).not.toContain('more (--all');
    expect(text).toContain('t-059');
  });

  it('names the command an older daemon lacks', async () => {
    answers.delete('GET /api/linear/coverage');
    await expect(run('coverage')).rejects.toThrow(
      'this dispatchd predates dispatch linear coverage; update Dispatch and try again'
    );
  });

  it('names the command run, not the route that failed first', async () => {
    answers.delete('GET /api/linear/export');
    answers.delete('POST /api/linear/export');
    await expect(run('push', '--all')).rejects.toThrow(
      'this dispatchd predates dispatch linear push; update Dispatch and try again'
    );
    answers.delete('GET /api/linear/capacity');
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await expect(run('archive-closed')).rejects.toThrow(
      'this dispatchd predates dispatch linear archive-closed; update Dispatch and try again'
    );
  });
});

describe('dispatch linear capacity', () => {
  it('prints the room left, refreshed on request', async () => {
    await run('capacity', '--refresh');
    expect(seen.map((s) => s.path)).toEqual(['/api/linear/capacity?refresh=1']);
    expect(lines.join('\n')).toContain('room for 10');
  });
});

describe('dispatch linear archive-closed', () => {
  it('refuses without the app token, before any request', async () => {
    await expect(run('archive-closed', '--yes')).rejects.toThrow(
      'dispatch linear archive-closed needs the daemon app token'
    );
    expect(seen).toEqual([]);
  });

  it('a no at the prompt archives nothing', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    const asked: string[] = [];
    ctx.confirm = (q) => {
      asked.push(q);
      return Promise.resolve(false);
    };
    await expect(run('archive-closed', '--canceled')).rejects.toThrow(
      'not archived; pass --yes to archive without a prompt'
    );
    expect(asked[0]).toContain(
      'Archive 143 closed issues (120 completed and 23 canceled) in Linear?'
    );
    expect(writes()).toEqual([]);
  });

  it('on a push-only link the prompt says the tasks here stay as they are', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    status = { ...status, direction: 'push' };
    const asked: string[] = [];
    ctx.confirm = (q) => {
      asked.push(q);
      return Promise.resolve(false);
    };
    await expect(run('archive-closed')).rejects.toThrow('not archived');
    expect(asked[0]).toContain('Their tasks here stay as they are');
    expect(asked[0]).not.toContain('archived too');
  });

  it('--dry-run says how many and sends nothing', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await run('archive-closed', '--dry-run');
    expect(writes()).toEqual([]);
    expect(lines).toContain('Would archive 120 completed issues in Linear.');
    expect(lines.join('\n')).toContain('add --canceled');
  });

  it('--yes archives on the app token and reports the outcome', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await run('archive-closed', '--yes');
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: '/api/linear/archive-closed',
        auth: `Bearer ${APP_TOKEN}`,
        body: '{"includeCanceled":false}',
      },
    ]);
    expect(lines).toContain('120 of 120 closed issues archived in Linear.');
  });
});
