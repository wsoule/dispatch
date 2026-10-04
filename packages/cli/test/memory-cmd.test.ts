import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { daemonFilePath } from '../src/commands/daemon.js';
import type { CliContext } from '../src/context.js';
import { CliError } from '../src/context.js';
import { makeProgram } from '../src/program.js';

const AGENT_TOKEN = 'agent-token-from-the-daemon-file';
const APP_TOKEN = 'app-token-only-a-human-has';
const TEAMMATE_TOKEN = 'teammate-token-request-tier';

const DRY_RUN_TEXT = 'outcome: dry-run\nledger rows read      330';
const MISMATCH_TEXT = 'outcome: MISMATCH — memory rows 3 → 4, expected 5';
const PROPOSAL = 'mp-01K5ZQ8M4N6P7R8S9T0V1W2X3Y';

interface FakeEntry {
  id: string;
  handle: string;
  kind: string;
  scope: string;
  state: string;
  title: string;
  body: string;
  trust: string;
  origin: string | null;
}

let root: string;
let fakeHome: string;
let lines: string[];
let ctx: CliContext;
let server: ReturnType<typeof Bun.serve>;
// Every request the fake daemon saw, so a test can assert what was not sent too.
let received: {
  path: string;
  method: string;
  auth: string | null;
  search: string;
  body: unknown;
}[];
let queries: string[];
let outcome: 'dry-run' | 'ok' | 'MISMATCH';
let entries: FakeEntry[];
// Confirms the fake answers without raising trust, as a confirm that did not take.
let confirmsTake: boolean;
// What the fake's Claude-notes import answers.
let claudeReport: Record<string, unknown>;
const originalDispatchHome = process.env.DISPATCH_HOME;
const originalAppToken = process.env.DISPATCH_APP_TOKEN;

async function run(...argv: string[]) {
  await makeProgram(ctx).parseAsync(argv, { from: 'user' });
}

function entry(handle: string, over: Partial<FakeEntry> = {}): FakeEntry {
  return {
    id: `mem-${handle.slice(1)}`,
    handle,
    kind: 'hazard',
    scope: 'project',
    state: 'active',
    title: `lesson ${handle}`,
    body: 'the body',
    trust: 'agent',
    origin: `ledger:l-${handle.slice(1)}@2026-09-01`,
    ...over,
  };
}

const forbidden = (error: string) =>
  Response.json({ error, code: 'forbidden' }, { status: 403 });

// The memory routes behind the owner's app token or a teammate's token.
function memoryRoute(
  url: URL,
  method: string,
  who: 'owner' | 'teammate',
  body: Record<string, unknown>
): Response {
  const parts = url.pathname.split('/').slice(3);
  const find = (ref: string) =>
    entries.find((e) => e.handle === decodeURIComponent(ref));
  if (parts.length === 0 && method === 'GET') {
    const origin = url.searchParams.get('origin');
    const trust = url.searchParams.get('trust');
    return Response.json({
      entries: entries.filter(
        (e) =>
          (origin === null || e.origin?.startsWith(`${origin}:`) === true) &&
          (trust === null || e.trust === trust)
      ),
    });
  }
  if (parts.length === 0 && method === 'POST') {
    if (who === 'teammate' && body.scope !== 'personal')
      return Response.json(
        { status: 'proposed', proposal: PROPOSAL, gate: 'm-gate-1' },
        { status: 201 }
      );
    return Response.json(
      { status: 'active', id: 'mem-NEW', handle: '#CCCCCCCC' },
      { status: 201 }
    );
  }
  if (parts[0] === 'proposals')
    return Response.json({
      proposals: [
        {
          id: PROPOSAL,
          state: 'open',
          action: 'add',
          scope: 'team',
          target: null,
          content: { kind: 'hazard', title: 'flaky tests' },
        },
      ],
    });
  if (parts[0] === 'link')
    return Response.json(
      parts.length === 2
        ? { identity: 'pid-01K5ZQ8M4N6P7R8S9T0V1W2X3Y' }
        : body.fresh === true
          ? { identity: 'pid-01K5ZQ8M4N6P7R8S9T0V1W2X3Z' }
          : { code: '7QX2-K9PA', expiresAt: '2026-09-28T10:10:00.000Z' }
    );
  const target = find(parts[0]);
  if (target === undefined)
    return Response.json({ error: 'not found' }, { status: 404 });
  if (parts.length === 1 && method === 'GET')
    return Response.json({
      entry: target,
      revisions: [{ rev: 1 }],
      recallCount: 3,
    });
  if (parts.length === 1 && method === 'DELETE')
    return new Response(null, { status: 204 });
  switch (parts[1]) {
    case 'confirm':
      if (confirmsTake) target.trust = 'confirmed';
      return Response.json(target);
    case 'retire':
      return Response.json({
        status: 'retired',
        id: target.id,
        handle: target.handle,
      });
    case 'promote':
      return Response.json({
        status: 'active',
        id: 'mem-PROMOTED',
        handle: '#DDDDDDDD',
      });
    default:
      return Response.json(target);
  }
}

// A fake dispatchd: the import route, like the real one, needs a deciding
// human, and every memory route refuses the daemon file's agent token.
function startFakeDaemon(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get('authorization');
      const text = await req.text();
      const body =
        text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
      received.push({
        path: url.pathname,
        method: req.method,
        auth,
        search: url.search,
        body: text === '' ? undefined : body,
      });
      if (url.pathname === '/api/health') return Response.json({ ok: true });
      if (url.pathname === '/api/memory/import/claude') {
        if (auth !== `Bearer ${APP_TOKEN}`)
          return forbidden(
            "only the daemon's own human imports its Claude notes"
          );
        return Response.json({ report: claudeReport });
      }
      if (url.pathname === '/api/memory/import/ledger') {
        if (auth !== `Bearer ${APP_TOKEN}`)
          return forbidden('the ledger import needs the decide tier');
        queries.push(url.search);
        return Response.json({
          report: { outcome, read: 330 },
          text: outcome === 'MISMATCH' ? MISMATCH_TEXT : DRY_RUN_TEXT,
        });
      }
      const who =
        auth === `Bearer ${APP_TOKEN}`
          ? 'owner'
          : auth === `Bearer ${TEAMMATE_TOKEN}`
            ? 'teammate'
            : null;
      if (who === null) return forbidden('memory refuses the agent token');
      if (url.pathname.startsWith('/api/memory'))
        return memoryRoute(url, req.method, who, body);
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-memory-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-memory-'));
  process.env.DISPATCH_HOME = fakeHome;
  delete process.env.DISPATCH_APP_TOKEN;
  lines = [];
  received = [];
  queries = [];
  outcome = 'dry-run';
  entries = [];
  confirmsTake = true;
  claudeReport = {
    state: 'complete',
    source: '/home/wyat/.claude/projects/-home-wyat-app/memory',
    imported: 3,
    updated: 1,
    unchanged: 2,
    duplicates: 0,
    tombstoned: 1,
    problems: ['huge.md: too-large'],
    candidates: [],
  };
  ctx = { cwd: root, log: (l) => lines.push(l) };
  await run('init');
  lines = [];

  server = startFakeDaemon();
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
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  if (originalAppToken === undefined) delete process.env.DISPATCH_APP_TOKEN;
  else process.env.DISPATCH_APP_TOKEN = originalAppToken;
});

describe('dispatch memory import-ledger', () => {
  it('posts a dry run with the app token and prints the report text', async () => {
    await run('memory', 'import-ledger', '--dry-run', '--token', APP_TOKEN);
    const post = received.find((r) => r.path === '/api/memory/import/ledger');
    expect(post).toMatchObject({
      path: '/api/memory/import/ledger',
      method: 'POST',
      auth: `Bearer ${APP_TOKEN}`,
    });
    expect(queries).toEqual(['?dryRun=1']);
    expect(lines.join('\n')).toContain('ledger rows read');
  });

  it('imports for real without --dry-run, reading DISPATCH_APP_TOKEN', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    outcome = 'ok';
    await run('memory', 'import-ledger');
    expect(queries).toEqual(['']);
  });

  it('prints the report as JSON with --json', async () => {
    await run(
      'memory',
      'import-ledger',
      '--dry-run',
      '--json',
      '--token',
      APP_TOKEN
    );
    expect(JSON.parse(lines.join('\n'))).toEqual({
      outcome: 'dry-run',
      read: 330,
    });
  });

  it('prints a MISMATCH report and then fails', async () => {
    outcome = 'MISMATCH';
    await expect(
      run('memory', 'import-ledger', '--token', APP_TOKEN)
    ).rejects.toThrow(/MISMATCH: nothing was written/);
    expect(lines).toEqual([MISMATCH_TEXT]);
  });

  it('refuses without an app token and says why', async () => {
    await expect(run('memory', 'import-ledger', '--dry-run')).rejects.toThrow(
      CliError
    );
    await expect(run('memory', 'import-ledger', '--dry-run')).rejects.toThrow(
      /needs the daemon app token/
    );
    expect(received.some((r) => r.path.startsWith('/api/memory'))).toBe(false);
  });

  it('surfaces the daemon 403 when the token supplied is only agent-tier', async () => {
    await expect(
      run('memory', 'import-ledger', '--dry-run', '--token', AGENT_TOKEN)
    ).rejects.toThrow(/needs the decide tier/);
  });
});

describe('dispatch memory import-claude', () => {
  const imports = () =>
    received
      .filter((r) => r.path === '/api/memory/import/claude')
      .map((r) => [r.method, r.search]);

  it('posts a dry run from an absolute --from and prints what it did', async () => {
    await run(
      'memory',
      'import-claude',
      '--from',
      'notes',
      '--dry-run',
      '--token',
      APP_TOKEN
    );
    expect(imports()).toEqual([
      [
        'POST',
        `?${new URLSearchParams({ from: join(root, 'notes'), dryRun: '1' }).toString()}`,
      ],
    ]);
    expect(lines).toEqual([
      'dry run, complete from /home/wyat/.claude/projects/-home-wyat-app/memory: imported 3 · updated 1 · unchanged 2 · duplicates 0 · tombstoned 1',
      'problem: huge.md: too-large',
    ]);
  });

  it('records that there are no notes with --none, or prints the report as JSON', async () => {
    await run(
      'memory',
      'import-claude',
      '--none',
      '--json',
      '--token',
      APP_TOKEN
    );
    expect(imports()).toEqual([['POST', '?none=1']]);
    expect(JSON.parse(lines.join('\n'))).toEqual(claudeReport);
  });

  it('lists the candidates when no notes were found', async () => {
    claudeReport = {
      ...claudeReport,
      state: 'unconfirmed',
      source: null,
      imported: 0,
      problems: [],
      candidates: ['/home/wyat/.claude/projects/-old-app/memory'],
    };
    await run('memory', 'import-claude', '--token', APP_TOKEN);
    expect(imports()).toEqual([['POST', '']]);
    expect(lines.slice(1)).toEqual([
      'candidate: /home/wyat/.claude/projects/-old-app/memory',
      'answer with `dispatch memory import-claude --from <dir>` or `--none`',
    ]);
  });

  it('fails with the problem when the import failed', async () => {
    claudeReport = {
      ...claudeReport,
      state: 'failed',
      problems: ['.: unreadable'],
    };
    await expect(
      run('memory', 'import-claude', '--token', APP_TOKEN)
    ).rejects.toThrow(/Claude notes import failed: \.: unreadable/);
  });

  it('asks for --from or --none, not both, before calling the daemon', async () => {
    await expect(
      run(
        'memory',
        'import-claude',
        '--from',
        '/x',
        '--none',
        '--token',
        APP_TOKEN
      )
    ).rejects.toThrow(/--from or --none, not both/);
    expect(imports()).toEqual([]);
  });

  it('surfaces the daemon 403 for a teammate', async () => {
    await expect(
      run('memory', 'import-claude', '--token', TEAMMATE_TOKEN)
    ).rejects.toThrow(/own human imports its Claude notes/);
  });
});

describe('dispatch memory', () => {
  const memoryCalls = () =>
    received
      .filter((r) => r.path.startsWith('/api/memory'))
      .map((r) => [r.method, `${r.path}${r.search}`, r.body]);

  it('refuses the daemon file’s agent token with the reason', async () => {
    delete process.env.DISPATCH_APP_TOKEN;
    await expect(run('memory', 'list')).rejects.toThrow(
      /needs the daemon app token/
    );
    expect(received.some((r) => r.path.startsWith('/api/memory'))).toBe(false);
  });

  it('lists one line per entry, passing the filters, or JSON', async () => {
    entries = [entry('#AAAAAAAA'), entry('#BBBBBBBB', { kind: 'decision' })];
    await run(
      'memory',
      'list',
      '--scope',
      'project',
      '--kind',
      'hazard',
      '--state',
      'all',
      '--token',
      APP_TOKEN
    );
    expect(received.at(-1)?.search).toBe(
      '?scope=project&kind=hazard&state=all'
    );
    expect(lines).toEqual([
      '#AAAAAAAA  hazard  project  active  lesson #AAAAAAAA',
      '#BBBBBBBB  decision  project  active  lesson #BBBBBBBB',
    ]);
    lines = [];
    await run('memory', 'list', '--json', '--token', APP_TOKEN);
    expect(
      (JSON.parse(lines.join('\n')) as FakeEntry[]).map((e) => e.handle)
    ).toEqual(['#AAAAAAAA', '#BBBBBBBB']);
  });

  it('strips control characters from titles it prints', async () => {
    entries = [
      entry('#AAAAAAAA', { title: 'clear \u001b[2Jscreen \u202eevil' }),
    ];
    await run('memory', 'list', '--token', APP_TOKEN);
    expect(lines).toEqual([
      '#AAAAAAAA  hazard  project  active  clear [2Jscreen evil',
    ]);
  });

  it('shows one entry with its body, by handle', async () => {
    entries = [entry('#AAAAAAAA')];
    await run('memory', 'show', '#AAAAAAAA', '--token', APP_TOKEN);
    expect(received.at(-1)?.path).toBe(
      `/api/memory/${encodeURIComponent('#AAAAAAAA')}`
    );
    expect(lines[0]).toBe(
      '#AAAAAAAA  hazard  project  active  lesson #AAAAAAAA'
    );
    expect(lines.join('\n')).toContain('the body');
    expect(lines.join('\n')).toContain('trust agent');
  });

  it('saves a personal entry and prints its handle', async () => {
    await run(
      'memory',
      'save',
      '--scope',
      'personal',
      '--kind',
      'preference',
      '--title',
      'terse comments',
      '--project-only',
      '--token',
      APP_TOKEN
    );
    expect(memoryCalls()).toEqual([
      [
        'POST',
        '/api/memory',
        {
          scope: 'personal',
          kind: 'preference',
          title: 'terse comments',
          body: '',
          projectOnly: true,
        },
      ],
    ]);
    expect(lines).toEqual(['saved #CCCCCCCC']);
  });

  it('prints a proposal result with where to review it', async () => {
    await run(
      'memory',
      'save',
      '--scope',
      'team',
      '--kind',
      'hazard',
      '--title',
      'flaky tests',
      '--token',
      TEAMMATE_TOKEN
    );
    expect(lines.join('\n')).toContain('proposed as mp-');
    expect(lines.join('\n')).toContain('waiting for a human in Needs you');
  });

  it('forgets with a reason and runs the one-ref commands', async () => {
    entries = [entry('#AAAAAAAA')];
    const ref = encodeURIComponent('#AAAAAAAA');
    await run(
      'memory',
      'forget',
      '#AAAAAAAA',
      '--reason',
      'wrong',
      '--token',
      APP_TOKEN
    );
    for (const verb of ['undo', 'confirm', 'pin', 'unpin', 'delete'])
      await run('memory', verb, '#AAAAAAAA', '--token', APP_TOKEN);
    await run(
      'memory',
      'promote',
      '#AAAAAAAA',
      '--scope',
      'team',
      '--token',
      APP_TOKEN
    );
    expect(memoryCalls()).toEqual([
      ['POST', `/api/memory/${ref}/retire`, { reason: 'wrong' }],
      ['POST', `/api/memory/${ref}/undo`, undefined],
      ['POST', `/api/memory/${ref}/confirm`, undefined],
      ['POST', `/api/memory/${ref}/pin`, undefined],
      ['POST', `/api/memory/${ref}/unpin`, undefined],
      ['DELETE', `/api/memory/${ref}`, undefined],
      ['POST', `/api/memory/${ref}/promote`, { scope: 'team' }],
    ]);
    expect(lines).toEqual([
      'retired #AAAAAAAA',
      'undone: #AAAAAAAA  hazard  project  active  lesson #AAAAAAAA',
      'confirmed #AAAAAAAA',
      'pinned #AAAAAAAA',
      'unpinned #AAAAAAAA',
      'deleted #AAAAAAAA',
      'saved #DDDDDDDD',
    ]);
  });

  it('bulk-confirms agent-trust entries from one origin, page by page', async () => {
    entries = [
      entry('#AAAAAAAA'),
      entry('#BBBBBBBB'),
      entry('#EEEEEEEE', { origin: 'claude:aaaaaaaaaaaa/a.md' }),
    ];
    await run('memory', 'confirm', '--origin', 'ledger', '--token', APP_TOKEN);
    expect(
      received.filter((r) => r.path.endsWith('/confirm')).map((r) => r.path)
    ).toEqual([
      `/api/memory/${encodeURIComponent('#AAAAAAAA')}/confirm`,
      `/api/memory/${encodeURIComponent('#BBBBBBBB')}/confirm`,
    ]);
    expect(
      received.filter((r) => r.path === '/api/memory').map((r) => r.search)
    ).toEqual([
      '?origin=ledger&trust=agent&limit=200',
      '?origin=ledger&trust=agent&limit=200',
    ]);
    expect(lines.at(-1)).toBe('confirmed 2 entries from ledger');
  });

  it('stops the bulk confirm when a page does not shrink', async () => {
    entries = [entry('#AAAAAAAA')];
    confirmsTake = false;
    await expect(
      run('memory', 'confirm', '--origin', 'ledger', '--token', APP_TOKEN)
    ).rejects.toThrow(/#AAAAAAAA is still agent trust/);
    expect(received.filter((r) => r.path.endsWith('/confirm'))).toHaveLength(1);
  });

  it('asks for a ref or an origin, not both', async () => {
    await expect(
      run('memory', 'confirm', '--token', APP_TOKEN)
    ).rejects.toThrow(/a ref or --origin/);
    await expect(
      run(
        'memory',
        'confirm',
        '#AAAAAAAA',
        '--origin',
        'ledger',
        '--token',
        APP_TOKEN
      )
    ).rejects.toThrow(/a ref or --origin/);
    await expect(
      run('memory', 'confirm', '--origin', 'docs', '--token', APP_TOKEN)
    ).rejects.toThrow(/--origin: expected ledger or claude/);
  });

  it('lists proposals with their state', async () => {
    await run('memory', 'proposals', '--state', 'open', '--token', APP_TOKEN);
    expect(received.at(-1)?.search).toBe('?state=open');
    expect(lines).toEqual([`${PROPOSAL}  open  add  team  flaky tests`]);
  });

  it('prints a link code, completes one, and starts fresh', async () => {
    await run('memory', 'link', '--token', TEAMMATE_TOKEN);
    await run('memory', 'link', '7QX2-K9PA', '--token', TEAMMATE_TOKEN);
    await run('memory', 'link', '--fresh', '--token', TEAMMATE_TOKEN);
    expect(memoryCalls()).toEqual([
      ['POST', '/api/memory/link', {}],
      ['POST', '/api/memory/link/7QX2-K9PA', undefined],
      ['POST', '/api/memory/link', { fresh: true }],
    ]);
    expect(lines[0]).toContain('dispatch memory link 7QX2-K9PA');
    expect(lines[1]).toBe('linked to identity pid-01K5ZQ8M4N6P7R8S9T0V1W2X3Y');
    expect(lines[2]).toBe(
      'started a fresh identity pid-01K5ZQ8M4N6P7R8S9T0V1W2X3Z'
    );
  });
});
