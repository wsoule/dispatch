import type { DocRevisionInfo } from '@dispatch/core';
import { parseDocFile } from '@dispatch/core';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { daemonFilePath } from '../src/commands/daemon.js';
import { editLoop, exportDocs, importFiles } from '../src/commands/docs.js';
import type { CliContext } from '../src/context.js';
import type { DocsApi, ImportReportInfo } from '../src/docsApi.js';
import { makeProgram } from '../src/program.js';

// A DocsApi whose saveBody answers a scripted sequence and records what it got.
function fakeApi(
  outcomes: ('conflict' | 'base-changed' | 'saved' | 'proposed')[],
  scope: 'team' | 'personal' = 'team'
) {
  const saves: { baseRev: string | number; baseHash?: string; body: string }[] =
    [];
  let seals = 0;
  const doc = { handle: 'spec', scope };
  const api = {
    get: () =>
      Promise.resolve({
        doc,
        rev: { id: 'rev-1', n: 1, hash: 'h1' },
        text: 'original\n',
      }),
    saveBody: (
      _ref: string,
      input: { baseRev: string | number; baseHash?: string; body: string }
    ) => {
      saves.push(input);
      const next = outcomes.shift();
      if (next === 'base-changed') {
        // The head was amended in place, so only its body comes back.
        return Promise.resolve({
          ok: false as const,
          conflict: {
            code: 'conflict',
            reason: 'base-changed',
            head: {
              id: 'rev-1',
              n: 1,
              hash: 'h1b',
              body: 'original\ndesktop line\n',
              author: 'human:wyat',
            },
            base: null,
            hunks: [],
            marked: 'original\ndesktop line\n',
          },
        });
      }
      if (next === 'conflict') {
        return Promise.resolve({
          ok: false as const,
          conflict: {
            code: 'conflict',
            reason: 'merge-conflict',
            head: {
              id: 'rev-2',
              n: 2,
              hash: 'h2',
              body: 'theirs\n',
              author: 'run:r-1',
            },
            base: { id: 'rev-1', n: 1 },
            hunks: [],
            marked:
              '<<<<<<< head (rev 2, run:r-1)\ntheirs\n=======\nmine\n>>>>>>> yours\n',
          },
        });
      }
      return Promise.resolve({
        ok: true as const,
        result: {
          doc,
          handle: 'spec',
          rev: { id: 'rev-3', n: 3, hash: 'h3' },
          status: next === 'proposed' ? 'proposed' : 'saved',
          proposal: 'rev-p',
          gate: 'm-g',
        },
      });
    },
    seal: () => {
      seals += 1;
      return Promise.resolve({});
    },
  } as unknown as DocsApi;
  return { api, saves, seals: () => seals };
}

const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'docs-edit-')));
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

describe('dispatch docs edit', () => {
  it('saves with base and hash, loops once on a conflict against the head, then seals', async () => {
    const { api, saves, seals } = fakeApi(['conflict', 'saved']);
    const seen: string[] = [];
    const writes = ['mine\n', 'resolved\n'];
    const result = await editLoop(api, 'spec', {
      tmpDir,
      runEditor: (path) => {
        seen.push(readFileSync(path, 'utf8'));
        // The second pass keeps the header line, as an editor that leaves it would.
        const header = seen.length === 2 ? `${seen[1].split('\n')[0]}\n` : '';
        writeFileSync(path, `${header}${writes[seen.length - 1]}`);
        return 0;
      },
      log: () => undefined,
    });
    expect(result).toBe('saved');
    expect(seen[0]).toBe('original\n');
    expect(
      seen[1].startsWith(
        '<!-- dispatch: resolve the marked blocks, then save; saving against rev 2 (rev-2) -->\n<<<<<<< head'
      )
    ).toBe(true);
    expect(saves.map((s) => [s.baseRev, s.baseHash, s.body])).toEqual([
      ['rev-1', 'h1', 'mine\n'],
      ['rev-2', 'h2', 'resolved\n'],
    ]);
    expect(seals()).toBe(1);
  });

  it('keeps what was typed beside the amended head when the base changed', async () => {
    const { api, saves } = fakeApi(['base-changed', 'saved']);
    const seen: string[] = [];
    const lines: string[] = [];
    const result = await editLoop(api, 'spec', {
      tmpDir,
      runEditor: (path) => {
        seen.push(readFileSync(path, 'utf8'));
        if (seen.length === 1) writeFileSync(path, 'original\ncli line\n');
        else writeFileSync(path, 'original\ndesktop line\ncli line\n');
        return 0;
      },
      log: (l) => lines.push(l),
    });
    expect(result).toBe('saved');
    expect(seen[1]).toBe(
      [
        '<!-- dispatch: resolve the marked blocks, then save; saving against rev 1 (rev-1) -->',
        '<<<<<<< head (rev 1, human:wyat)',
        'original',
        'desktop line',
        '=======',
        'original',
        'cli line',
        '>>>>>>> yours',
        '',
      ].join('\n')
    );
    expect(lines[0]).toContain('marked block');
    expect(saves.map((s) => [s.baseRev, s.baseHash])).toEqual([
      ['rev-1', 'h1'],
      ['rev-1', 'h1b'],
    ]);
  });

  it('loads the head alone when the base changed and nothing was typed', async () => {
    const { api } = fakeApi(['base-changed', 'saved']);
    const seen: string[] = [];
    await editLoop(api, 'spec', {
      tmpDir,
      runEditor: (path) => {
        seen.push(readFileSync(path, 'utf8'));
        if (seen.length === 2) writeFileSync(path, 'resolved\n');
        return 0;
      },
      log: () => undefined,
    });
    expect(seen[1]).toBe(
      '<!-- dispatch: resolve the marked blocks, then save; saving against rev 1 (rev-1) -->\noriginal\ndesktop line\n'
    );
  });

  it('aborts on an empty file without saving', async () => {
    const { api, saves } = fakeApi([]);
    const result = await editLoop(api, 'spec', {
      tmpDir,
      runEditor: (path) => (writeFileSync(path, '  \n'), 0),
      log: () => undefined,
    });
    expect(result).toBe('aborted');
    expect(saves).toEqual([]);
  });

  it('refuses a failed editor without saving', async () => {
    const { api, saves } = fakeApi([]);
    await expect(
      editLoop(api, 'spec', {
        tmpDir,
        runEditor: () => 1,
        log: () => undefined,
      })
    ).rejects.toThrow('the editor exited with 1');
    expect(saves).toEqual([]);
  });

  it('names a personal doc it saved ~slug', async () => {
    const { api } = fakeApi(['saved'], 'personal');
    const lines: string[] = [];
    await editLoop(api, '~spec', {
      tmpDir,
      runEditor: (path) => (writeFileSync(path, 'x\n'), 0),
      log: (l) => lines.push(l),
    });
    expect(lines).toEqual(['saved ~spec rev 3']);
  });

  it('prints the gate when an accepted doc takes the save as a proposal', async () => {
    const { api, seals } = fakeApi(['proposed']);
    const lines: string[] = [];
    await editLoop(api, 'spec', {
      tmpDir,
      runEditor: (path) => (writeFileSync(path, 'x\n'), 0),
      log: (l) => lines.push(l),
    });
    expect(lines.join('\n')).toContain(
      'proposed for review as rev-p (gate m-g)'
    );
    expect(seals()).toBe(0);
  });
});

describe('dispatch docs import', () => {
  it('uploads only what the daemon needs, then commits', async () => {
    const a = join(tmpDir, 'a.md');
    const b = join(tmpDir, 'b.md');
    writeFileSync(a, '# A\n');
    writeFileSync(b, '# B\n');
    const calls: string[] = [];
    let manifest: { name: string; bytes: number; hash: string }[] = [];
    const api = {
      openImport: (files: typeof manifest, link?: string) => {
        manifest = files;
        calls.push(`open ${files.length} ${link ?? '-'}`);
        return Promise.resolve({ id: 'imp-1', need: [files[1].hash] });
      },
      putImportContent: (id: string, hash: string, bytes: Uint8Array) => {
        calls.push(
          `put ${id} ${hash === manifest[1].hash ? 'b' : '?'} ${new TextDecoder().decode(bytes)}`
        );
        return Promise.resolve();
      },
      commitImport: (id: string, dryRun: boolean) => {
        calls.push(`commit ${id} ${dryRun}`);
        return Promise.resolve({
          dryRun,
          parity: { files: true, names: true },
        });
      },
      deleteImport: (id: string) => {
        calls.push(`delete ${id}`);
        return Promise.resolve();
      },
    } as unknown as DocsApi;
    await importFiles(api, [a, b], { link: 'task:t-1', dryRun: true });
    expect(manifest.map((f) => [f.name, f.bytes])).toEqual([
      ['a.md', 4],
      ['b.md', 4],
    ]);
    expect(calls).toEqual([
      'open 2 task:t-1',
      'put imp-1 b # B\n',
      'commit imp-1 true',
      'delete imp-1',
    ]);
  });
});

describe('dispatch docs import with unreadable paths', () => {
  it('reports a missing path and a directory by name and imports the rest', async () => {
    const good = join(tmpDir, 'good.md');
    writeFileSync(good, '# Good\n');
    const dir = join(tmpDir, 'folder.md');
    mkdirSync(dir, { recursive: true });
    const gone = join(tmpDir, 'gone.md');
    let sent: string[] = [];
    const api = {
      openImport: (files: { name: string }[]) => {
        sent = files.map((f) => f.name);
        return Promise.resolve({ id: 'imp-1', need: [] });
      },
      putImportContent: () => Promise.resolve(),
      commitImport: (): Promise<ImportReportInfo> =>
        Promise.resolve({
          dryRun: false,
          files: 1,
          names: 1,
          distinctContents: 1,
          docsCreated: 1,
          docsExisting: 0,
          partDocsCreated: 0,
          contentsImported: 1,
          splitContents: 0,
          revisionsCreated: 1,
          duplicates: 0,
          alreadyPresent: 0,
          tombstoned: 0,
          tombstonedNames: 0,
          failedNames: 0,
          errors: [],
          parity: { files: true, names: true },
        }),
      deleteImport: () => Promise.resolve(),
    } as unknown as DocsApi;
    const report = await importFiles(api, [good, gone, dir], { dryRun: false });
    expect(sent).toEqual(['good.md']);
    expect(report.errors.map((e) => [e.path, e.reason])).toEqual([
      [gone, 'missing'],
      [dir, 'missing'],
    ]);
    expect(report).toMatchObject({
      files: 3,
      names: 3,
      failedNames: 2,
      parity: { files: true, names: true },
    });
  });
});

// A revision of doc `a` for the export fake: n, its parents, author and sealed flag.
function rev(
  n: number,
  parents: number[],
  author: string,
  sealed = true
): DocRevisionInfo {
  return {
    id: `rev-${n}`,
    doc: 'doc-a',
    n,
    parents: parents.map((p) => `rev-${p}`),
    title: 'A',
    author,
    cause: 'save',
    summary: '',
    approval: null,
    hash: `h${n}`,
    bytes: 1,
    conflicted: false,
    sealed,
    unreviewed: false,
    provisional: false,
    via: null,
    createdAt: '2026-09-26T10:00:00.000Z',
    updatedAt: '2026-09-26T10:00:00.000Z',
  };
}

describe('dispatch docs export', () => {
  it('pages through every sealed revision and names only the head ancestry authors', async () => {
    // 205 revisions in a line, a side revision 206 off 205, and head 207 off 205.
    const revisions: DocRevisionInfo[] = [];
    for (let n = 1; n <= 205; n++)
      revisions.push(
        rev(
          n,
          n === 1 ? [] : [n - 1],
          n % 2 === 0 ? 'run:r-1' : 'human:wyat',
          n !== 3
        )
      );
    revisions.push(rev(206, [205], 'run:r-x'), rev(207, [205], 'human:wyat'));
    const newestFirst = [...revisions].reverse();
    const pages: (number | undefined)[] = [];
    const api = {
      list: () =>
        Promise.resolve({
          docs: [
            {
              id: 'doc-a',
              handle: 'a',
              title: 'A',
              status: 'draft',
              scope: 'team',
              updatedAt: '2026-09-26T11:00:00.000Z',
            },
          ],
          total: 1,
        }),
      get: () =>
        Promise.resolve({ rev: revisions[206], links: [], text: 'head\n' }),
      history: (_ref: string, limit: number, before?: number) => {
        pages.push(before);
        return Promise.resolve({
          revisions: newestFirst
            .filter((r) => before === undefined || (r.n ?? 0) < before)
            .slice(0, limit),
        });
      },
      revision: (_ref: string, id: string) =>
        Promise.resolve({ body: `${id}\n` }),
    } as unknown as DocsApi;
    const out = join(tmpDir, 'export');
    expect(await exportDocs(api, out, true)).toBe(1);
    expect(pages).toEqual([undefined, 8]);
    expect(readdirSync(join(out, '.history', 'a')).length).toBe(206);
    const parsed = parseDocFile(readFileSync(join(out, 'a.md'), 'utf8'));
    expect('meta' in parsed ? parsed.meta.authors : parsed.error).toEqual([
      'human:wyat',
      'run:r-1',
    ]);
  });

  it('keeps a personal and a team doc of one handle in separate files and histories', async () => {
    const summary = (id: string, scope: string) => ({
      id,
      handle: 'notes',
      title: 'Notes',
      status: 'draft',
      scope,
      updatedAt: '2026-09-26T11:00:00.000Z',
    });
    const api = {
      list: () =>
        Promise.resolve({
          docs: [summary('doc-t', 'team'), summary('doc-p', 'personal')],
          total: 2,
        }),
      get: (id: string) =>
        Promise.resolve({
          rev: rev(1, [], 'human:wyat'),
          links: [],
          text: `${id}\n`,
        }),
      history: () => Promise.resolve({ revisions: [rev(1, [], 'human:wyat')] }),
      revision: (id: string) => Promise.resolve({ body: `${id} rev 1\n` }),
    } as unknown as DocsApi;
    const out = join(tmpDir, 'export-scopes');
    expect(await exportDocs(api, out, true)).toBe(2);
    expect(readFileSync(join(out, '.history', 'notes', '1.md'), 'utf8')).toBe(
      'doc-t rev 1\n'
    );
    expect(
      readFileSync(join(out, 'personal', '.history', 'notes', '1.md'), 'utf8')
    ).toBe('doc-p rev 1\n');
  });
});

describe('dispatch docs handles', () => {
  const personal = {
    id: 'doc-p',
    handle: 'notes',
    title: 'Notes',
    scope: 'personal',
    status: 'draft',
    unreviewed: false,
    head: { n: 2 },
  };
  const team = { ...personal, id: 'doc-t', scope: 'team' };
  const saved = (rev: number) => ({
    doc: personal,
    handle: 'notes',
    rev: { id: `rev-${rev}`, n: rev, hash: 'h' },
    status: 'saved',
  });
  let root: string;
  let home: string;
  let lines: string[];
  let server: ReturnType<typeof Bun.serve>;
  const savedHome = process.env.DISPATCH_HOME;
  const run = (...argv: string[]) => {
    const ctx: CliContext = { cwd: root, log: (l) => lines.push(l) };
    return makeProgram(ctx).parseAsync(argv, { from: 'user' });
  };

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'docs-cmd-root-')));
    home = realpathSync(mkdtempSync(join(tmpdir(), 'docs-cmd-home-')));
    process.env.DISPATCH_HOME = home;
    lines = [];
    await run('init');
    lines = [];
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => {
        const { pathname } = new URL(req.url);
        if (pathname === '/api/health') return Response.json({ ok: true });
        if (pathname === '/api/docs' && req.method === 'POST')
          return Response.json(saved(1), { status: 201 });
        if (pathname === '/api/docs')
          return Response.json({ docs: [personal, team], total: 2 });
        if (pathname === '/api/docs/~notes/revert')
          return Response.json(saved(3));
        if (pathname === '/api/docs/~notes')
          return Response.json({
            doc: personal,
            rev: { n: 2, author: 'human:wyat' },
            outline: [],
            text: 'x\n',
          });
        return Response.json({ error: 'not found' }, { status: 404 });
      },
    });
    mkdirSync(dirname(daemonFilePath(root)), { recursive: true });
    writeFileSync(
      daemonFilePath(root),
      JSON.stringify({
        port: server.port,
        pid: process.pid,
        rootDir: root,
        startedAt: new Date().toISOString(),
        agentToken: 'agent-token',
      })
    );
  });

  afterEach(() => {
    void server.stop(true);
    if (savedHome === undefined) delete process.env.DISPATCH_HOME;
    else process.env.DISPATCH_HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('prints a personal doc as ~slug wherever it names one', async () => {
    const file = join(root, 'body.md');
    writeFileSync(file, 'x\n');
    const token = ['--token', 'app-token'];
    await run(
      'docs',
      'new',
      'Notes',
      '--scope',
      'personal',
      '--file',
      file,
      ...token
    );
    await run('docs', 'revert', '~notes', '1', ...token);
    await run('docs', 'list', ...token);
    await run('docs', 'show', '~notes', ...token);
    expect(lines.slice(0, 5)).toEqual([
      'created ~notes rev 1',
      'saved ~notes rev 3',
      '~notes\tdraft\trev 2\tNotes',
      'notes\tdraft\trev 2\tNotes',
      '~notes · draft · rev 2 by human:wyat · Notes',
    ]);
  });
});
