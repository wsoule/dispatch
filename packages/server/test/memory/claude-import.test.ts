import {
  createMemoryIds,
  openMemoryDb,
  parseMemoryFile,
  SqliteMemoryStore,
} from '@dispatch/memory';
import type { MemoryEntry, MemoryIds } from '@dispatch/memory';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import {
  findClaudeMemorySource,
  importClaudeNotes,
  sanitizeProjectDirName,
} from '../../src/memory/claudeImport.js';
import { projectKeyOf } from '../../src/orchestrator/paths.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { useTestAuth } from '../testAuth.js';

const NOW = new Date('2026-09-25T10:00:00.000Z');

// A synthetic `~/.claude` holding one project's notes, never the owner's own.
function writeNotes(home: string, checkout: string): string {
  const memoryDir = join(
    home,
    '.claude',
    'projects',
    sanitizeProjectDirName(checkout),
    'memory'
  );
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(
    join(memoryDir, 'MEMORY.md'),
    '- [Proto shims](proto-shims.md) — setup\n- [Terse comments](terse.md)\n- remember the 7-day release gate\n'
  );
  writeFileSync(
    join(memoryDir, 'proto-shims.md'),
    '---\nname: proto-shims\ndescription: proto shims live in ~/.proto/shims\nmetadata:\n  node_type: memory\n  type: project\n  originSessionId: 1\n  modified: 2026-09-01T00:00:00Z\n---\nexport PATH first'
  );
  writeFileSync(
    join(memoryDir, 'terse.md'),
    '---\nname: terse\nmetadata:\n  type: feedback\n---\nComments are one or two lines.'
  );
  return memoryDir;
}

function byOrigin(store: SqliteMemoryStore, origin: string): MemoryEntry {
  const entry = store.entryByOrigin(origin);
  if (entry === null) throw new Error(`no entry from ${origin}`);
  return entry;
}

describe('importClaudeNotes', () => {
  let checkout: string;
  let home: string;
  let memoryDir: string;
  let store: SqliteMemoryStore;
  let ids: MemoryIds;

  function fixtureHome(): { home: string; memoryDir: string } {
    const at = realpathSync(mkdtempSync(join(tmpdir(), 'claude-home-')));
    return { home: at, memoryDir: writeNotes(at, checkout) };
  }

  const run = (
    source: Parameters<typeof importClaudeNotes>[0]['source'],
    at = home
  ) =>
    importClaudeNotes({
      source,
      store,
      projectKey: 'aaaaaaaaaaaa',
      ownerRef: 'human:wyat',
      ids,
      now: NOW,
      home: at,
    });

  beforeEach(() => {
    checkout = realpathSync(mkdtempSync(join(tmpdir(), 'claude-checkout-')));
    ({ home, memoryDir } = fixtureHome());
    store = new SqliteMemoryStore(openMemoryDb(':memory:'));
    ids = createMemoryIds();
  });

  afterEach(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  });

  it('imports every note as the owner’s personal agent-trust memory and marks the import complete', async () => {
    const report = await importClaudeNotes({
      source: await findClaudeMemorySource({
        rootDir: checkout,
        mainCheckout: checkout,
        env: {},
        home,
      }),
      store,
      projectKey: 'aaaaaaaaaaaa',
      ownerRef: 'human:wyat',
      ids,
      now: NOW,
      home,
    });
    expect(report).toMatchObject({ state: 'complete', imported: 3 });
    const byTitle = Object.fromEntries(
      store.listEntries().map((e) => [e.title, e])
    );
    expect(byTitle['proto shims live in ~/.proto/shims']).toMatchObject({
      scope: 'personal',
      kind: 'fact',
      projectKey: 'aaaaaaaaaaaa',
      trust: 'agent',
      author: 'agent:wyat/claude-code',
      origin: 'claude:aaaaaaaaaaaa/proto-shims.md',
      createdAt: '2026-09-01T00:00:00Z',
      lastRecalledAt: NOW.toISOString(),
    });
    expect(byTitle['Terse comments']).toMatchObject({
      kind: 'preference',
      projectKey: null,
    });
    expect(byTitle['remember the 7-day release gate']).toMatchObject({
      kind: 'fact',
    });
    expect(store.meta('claude-import:aaaaaaaaaaaa')).toBe('complete');
    // The source is only read.
    expect(readFileSync(join(memoryDir, 'terse.md'), 'utf8')).toContain(
      'Comments are one or two lines.'
    );
  });

  it('is idempotent, writes a changed file as a new revision, and skips tombstoned origins', async () => {
    const found = await findClaudeMemorySource({
      rootDir: checkout,
      mainCheckout: checkout,
      env: {},
      home,
    });
    expect(await run(found)).toMatchObject({ state: 'complete', imported: 3 });
    expect(await run(found)).toMatchObject({ imported: 0, unchanged: 3 });
    const file = join(memoryDir, 'proto-shims.md');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        'export PATH first',
        'export PATH first, then proto use'
      )
    );
    expect(await run(found)).toMatchObject({ updated: 1, unchanged: 2 });
    expect(byOrigin(store, 'claude:aaaaaaaaaaaa/proto-shims.md')).toMatchObject(
      { rev: 2, body: 'export PATH first, then proto use' }
    );
    store.deleteEntry(
      byOrigin(store, 'claude:aaaaaaaaaaaa/terse.md').id,
      'human:wyat',
      NOW.toISOString()
    );
    expect(await run(found)).toMatchObject({ imported: 0, tombstoned: 1 });
    expect(store.entryByOrigin('claude:aaaaaaaaaaaa/terse.md')).toBeNull();
  });

  it('keeps a Dispatch-side edit when the file itself has not changed', async () => {
    const found = await findClaudeMemorySource({
      rootDir: checkout,
      mainCheckout: checkout,
      env: {},
      home,
    });
    await run(found);
    const entry = byOrigin(store, 'claude:aaaaaaaaaaaa/terse.md');
    store.updateEntry(
      { ...entry, title: 'Keep comments short', rev: entry.rev + 1 },
      'human:wyat',
      'edit'
    );
    expect(await run(found)).toMatchObject({ updated: 0, unchanged: 3 });
    expect(byOrigin(store, 'claude:aaaaaaaaaaaa/terse.md').title).toBe(
      'Keep comments short'
    );
  });

  it('skips a cross-project note already imported from another project, and writes nothing on a dry run', async () => {
    const found = await findClaudeMemorySource({
      rootDir: checkout,
      mainCheckout: checkout,
      env: {},
      home,
    });
    await importClaudeNotes({
      source: found,
      store,
      projectKey: 'bbbbbbbbbbbb',
      ownerRef: 'human:wyat',
      ids,
      now: NOW,
      home,
    });
    const before = store.countEntries();
    const dry = await importClaudeNotes({
      source: found,
      store,
      projectKey: 'aaaaaaaaaaaa',
      ownerRef: 'human:wyat',
      ids,
      now: NOW,
      home,
      dryRun: true,
    });
    // The project note narrows to this project; the two cross-project ones match.
    expect(dry).toMatchObject({
      state: 'complete',
      imported: 1,
      duplicates: 2,
    });
    expect(store.countEntries()).toBe(before);
    expect(store.meta('claude-import:aaaaaaaaaaaa')).toBeNull();
    expect(await run(found)).toMatchObject({ imported: 1, duplicates: 2 });
    expect(store.countEntries()).toBe(before + 1);
  });

  it('leaves the owner native when nothing is found: unconfirmed, with candidates', async () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'claude-home-')));
    const other = join(
      empty,
      '.claude',
      'projects',
      `-elsewhere-${sanitizeProjectDirName(basename(checkout))}`,
      'memory'
    );
    mkdirSync(other, { recursive: true });
    mkdirSync(join(empty, '.claude', 'projects', '-unrelated', 'memory'), {
      recursive: true,
    });
    const search = await findClaudeMemorySource({
      rootDir: checkout,
      mainCheckout: checkout,
      env: {},
      home: empty,
    });
    expect(search.found).toBeNull();
    expect(search.candidates).toEqual([other]);
    expect(await run(search, empty)).toMatchObject({
      state: 'unconfirmed',
      imported: 0,
      candidates: [other],
    });
    expect(store.meta('claude-import:aaaaaaaaaaaa')).toBe('unconfirmed');
    rmSync(empty, { recursive: true, force: true });
  });

  // A dotfile manager's ~/.claude symlink would make every candidate a
  // refused --from; offering the real path lets the owner import it.
  it('offers a candidate under a symlinked ~/.claude by its real path', async () => {
    const at = realpathSync(mkdtempSync(join(tmpdir(), 'claude-home-')));
    const real = join(at, 'dotfiles', 'claude');
    const notes = join(
      real,
      'projects',
      `-old-${sanitizeProjectDirName(basename(checkout))}`,
      'memory'
    );
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, 'note.md'), 'a note');
    symlinkSync(real, join(at, '.claude'));
    const search = await findClaudeMemorySource({
      rootDir: checkout,
      mainCheckout: checkout,
      env: {},
      home: at,
    });
    expect(search.candidates).toEqual([notes]);
    expect(await run({ explicit: notes }, at)).toMatchObject({
      state: 'complete',
      imported: 1,
    });
    rmSync(at, { recursive: true, force: true });
  });

  it('looks in CLAUDE_CONFIG_DIR under CLAUDE_CODE_PROJECT_DIR_NAME when they are set', async () => {
    const config = join(home, 'elsewhere');
    const named = join(config, 'projects', 'my-project', 'memory');
    mkdirSync(named, { recursive: true });
    const search = await findClaudeMemorySource({
      rootDir: checkout,
      mainCheckout: checkout,
      env: {
        CLAUDE_CONFIG_DIR: config,
        CLAUDE_CODE_PROJECT_DIR_NAME: 'my-project',
      },
      home,
    });
    expect(search.found).toEqual({ dir: named, from: 'default' });
  });

  it('records failed for an unreadable source and imports nothing', async () => {
    if (process.getuid?.() === 0) return; // root reads a 0000 directory anyway
    chmodSync(memoryDir, 0o000);
    try {
      const report = await run(
        await findClaudeMemorySource({
          rootDir: checkout,
          mainCheckout: checkout,
          env: {},
          home,
        })
      );
      expect(report.state).toBe('failed');
      expect(store.countEntries()).toBe(0);
      expect(store.meta('claude-import:aaaaaaaaaaaa')).toBe('failed');
    } finally {
      chmodSync(memoryDir, 0o755);
    }
  });

  it('asks for confirmation before using a project-sourced autoMemoryDirectory, and uses a user-sourced one as found', async () => {
    const notes = join(checkout, 'notes');
    mkdirSync(notes);
    const local = await findClaudeMemorySource({
      rootDir: checkout,
      mainCheckout: checkout,
      env: {},
      home,
      resolveEffective: () =>
        Promise.resolve({ value: notes, source: 'local' }),
    });
    expect(local).toMatchObject({ found: null, needsConfirmation: true });
    expect(local.candidates).toContain(notes);
    const user = await findClaudeMemorySource({
      rootDir: checkout,
      mainCheckout: checkout,
      env: {},
      home,
      resolveEffective: () =>
        Promise.resolve({ value: memoryDir, source: 'user' }),
    });
    expect(user.found).toEqual({ dir: memoryDir, from: 'user' });
  });

  it('refuses an explicit --from that is relative, outside home, or reached through a symlink', async () => {
    const relative = await run({ explicit: 'notes' });
    expect(relative.problems.join('\n')).toContain('absolute');
    const outside = await run({ explicit: '/etc' });
    expect(outside.problems.join('\n')).toContain('under the home directory');
    const link = join(home, 'linked-notes');
    symlinkSync(memoryDir, link);
    const viaLink = await run({ explicit: link });
    expect(viaLink.problems.join('\n')).toContain('symlink');
    for (const report of [relative, outside, viaLink])
      expect(report.state).not.toBe('complete');
    expect(store.countEntries()).toBe(0);
  });

  it('imports from an explicit --from, and --none records complete with nothing imported', async () => {
    expect(await run({ explicit: memoryDir })).toMatchObject({
      state: 'complete',
      source: memoryDir,
      imported: 3,
    });
    const other = new SqliteMemoryStore(openMemoryDb(':memory:'));
    const none = await importClaudeNotes({
      source: { none: true },
      store: other,
      projectKey: 'aaaaaaaaaaaa',
      ownerRef: 'human:wyat',
      ids,
      now: NOW,
      home,
    });
    expect(none).toMatchObject({ state: 'complete', imported: 0 });
    expect(other.meta('claude-import:aaaaaaaaaaaa')).toBe('complete');
    other.close();
  });

  it('recovers a note the first import cut plainly once docs can take it, and leaves cross-project notes alone (docs Task 18)', async () => {
    const DOC_ID = 'doc-01K3Z9R0000000000000000000';
    const longProject = `---\nname: long\ndescription: long project note\nmetadata:\n  type: project\n---\n${'line of text\n'.repeat(1000)}`;
    writeFileSync(join(memoryDir, 'long.md'), longProject);
    writeFileSync(
      join(memoryDir, 'long-pref.md'),
      longProject
        .replace('type: project', 'type: feedback')
        .replace('long project note', 'long preference')
    );
    const found = await findClaudeMemorySource({
      rootDir: checkout,
      mainCheckout: checkout,
      env: {},
      home,
    });
    const base = {
      source: found,
      store,
      projectKey: 'aaaaaaaaaaaa',
      ownerRef: 'human:wyat',
      ids,
      now: NOW,
      home,
    };
    await importClaudeNotes(base);
    const cut = store
      .listEntries()
      .find((e) => e.title === 'long project note');
    expect(cut?.body).toMatch(/long-form belongs in Docs\]$/);

    const calls: string[] = [];
    const overflow = (i: {
      entryId: string;
      identity: string;
      human: string;
    }) => {
      calls.push(`${i.entryId}@${i.identity}@${i.human}`);
      return DOC_ID;
    };
    // A dry run never creates a doc.
    await importClaudeNotes({
      ...base,
      overflow,
      identity: 'self',
      dryRun: true,
    });
    expect(calls).toEqual([]);
    const again = await importClaudeNotes({
      ...base,
      overflow,
      identity: 'self',
    });
    expect(again.updated).toBe(1);
    const recovered = store
      .listEntries()
      .find((e) => e.title === 'long project note');
    expect(recovered?.id).toBe(cut?.id);
    expect(recovered?.body).toMatch(
      new RegExp(`full text in doc ${DOC_ID} of project aaaaaaaaaaaa\\]$`)
    );
    expect(recovered?.refs).toContainEqual({ type: 'doc', id: DOC_ID });
    expect(calls).toEqual([`${cut?.id ?? ''}@self@human:wyat`]);
    expect(
      store.listEntries().find((e) => e.title === 'long preference')?.body
    ).toMatch(/long-form belongs in Docs\]$/);
    expect(
      (await importClaudeNotes({ ...base, overflow, identity: 'self' })).updated
    ).toBe(0);
  });

  it('writes docs only after the import commits, and never over an entry the owner edited', async () => {
    const longProject = `---\nname: long\ndescription: long project note\nmetadata:\n  type: project\n---\n${'line of text\n'.repeat(1000)}`;
    writeFileSync(join(memoryDir, 'long.md'), longProject);
    const base = {
      source: { explicit: memoryDir },
      store,
      projectKey: 'aaaaaaaaaaaa',
      ownerRef: 'human:wyat',
      ids,
      now: NOW,
      home,
    };
    const seen: (string | null)[] = [];
    await importClaudeNotes({
      ...base,
      identity: 'self',
      overflow: () => {
        // The import's own record is written by the time docs are asked.
        seen.push(store.meta('claude-import:aaaaaaaaaaaa'));
        return 'doc-01K3Z9R0000000000000000002';
      },
    });
    expect(seen).toEqual(['complete']);

    // An entry cut plainly and then edited by its owner is left alone.
    const other = new SqliteMemoryStore(openMemoryDb(':memory:'));
    try {
      const plain = { ...base, store: other };
      await importClaudeNotes(plain);
      const cut = other
        .listEntries()
        .find((e) => e.title === 'long project note');
      if (cut === undefined) throw new Error('no entry');
      other.updateEntry(
        { ...cut, body: 'my own short note', rev: cut.rev + 1 },
        'human:wyat',
        'edit'
      );
      const asked: string[] = [];
      const report = await importClaudeNotes({
        ...plain,
        identity: 'self',
        overflow: (i) => {
          asked.push(i.entryId);
          return 'doc-01K3Z9R0000000000000000003';
        },
      });
      expect(asked).toEqual([]);
      expect(report.updated).toBe(0);
      expect(other.getEntry(cut.id)?.body).toBe('my own short note');
    } finally {
      other.close();
    }
  });

  it('overflows a long project note on its first import when docs are there', async () => {
    const DOC_ID = 'doc-01K3Z9R0000000000000000001';
    writeFileSync(
      join(memoryDir, 'long.md'),
      `---\nname: long\ndescription: first long note\nmetadata:\n  type: project\n---\n${'line of text\n'.repeat(1000)}`
    );
    const report = await importClaudeNotes({
      source: { explicit: memoryDir },
      store,
      projectKey: 'aaaaaaaaaaaa',
      ownerRef: 'human:wyat',
      ids,
      now: NOW,
      home,
      overflow: () => DOC_ID,
      identity: 'self',
    });
    expect(report.problems).toEqual([]);
    const entry = store
      .listEntries()
      .find((e) => e.title === 'first long note');
    expect(entry?.body).toMatch(new RegExp(`full text in doc ${DOC_ID}`));
  });
});

describe('the daemon’s one-time import', () => {
  const originalHome = process.env.DISPATCH_HOME;
  let fakeHome: string;
  let root: string;
  let memoryDir: string;
  let handle: ServerHandle;
  let base: string;

  const boot = async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      webDistDir: null,
      writeDaemonFile: false,
      registerExecutors: () => {},
    });
    useTestAuth(handle);
    base = `http://127.0.0.1:${handle.port}`;
  };

  const self = () => handle.memory.personal.personal('self');

  beforeEach(async () => {
    fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-home-')));
    process.env.DISPATCH_HOME = fakeHome;
    root = realpathSync(initGitRepo('dispatch-claude-import-'));
    // Under a redirected DISPATCH_HOME, the Claude notes are looked for there too.
    memoryDir = writeNotes(fakeHome, root);
    await boot();
  });

  afterEach(async () => {
    await handle.stop();
    if (originalHome === undefined) delete process.env.DISPATCH_HOME;
    else process.env.DISPATCH_HOME = originalHome;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('imports once at boot and reports the state to the owner alone', async () => {
    expect(self().meta(`claude-import:${projectKeyOf(root)}`)).toBe('complete');
    expect(self().countEntries()).toBe(3);
    const health = (await (
      await fetch(`${base}/api/memory/health`)
    ).json()) as { claudeImport: unknown };
    expect(health.claudeImport).toEqual({
      state: 'complete',
      source: memoryDir,
      candidates: [],
      problems: [],
    });
    const ada = handle.team.teammates.issue('ada', 'decide');
    const theirs = (await (
      await fetch(`${base}/api/memory/health`, {
        headers: { authorization: `Bearer ${ada}` },
      })
    ).json()) as { claudeImport: unknown };
    expect(theirs.claudeImport).toBeNull();

    // A later boot leaves a recorded import alone.
    writeFileSync(join(memoryDir, 'later.md'), 'a note written later');
    await handle.stop();
    await boot();
    expect(self().countEntries()).toBe(3);
  });

  it('re-runs by hand for the owner only, with a dry run, --from and --none', async () => {
    writeFileSync(join(memoryDir, 'later.md'), 'a note written later');
    const ada = handle.team.teammates.issue('ada', 'decide');
    const refused = await fetch(`${base}/api/memory/import/claude`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ada}` },
    });
    expect(refused.status).toBe(403);

    const both = await fetch(
      `${base}/api/memory/import/claude?none=1&from=${encodeURIComponent(memoryDir)}`,
      { method: 'POST' }
    );
    expect(both.status).toBe(400);

    const post = async (query: string) =>
      (
        (await (
          await fetch(`${base}/api/memory/import/claude${query}`, {
            method: 'POST',
          })
        ).json()) as { report: Record<string, unknown> }
      ).report;
    expect(await post('?dryRun=1')).toMatchObject({
      state: 'complete',
      imported: 1,
      unchanged: 3,
    });
    expect(self().countEntries()).toBe(3);
    expect(await post(`?from=${encodeURIComponent(memoryDir)}`)).toMatchObject({
      state: 'complete',
      source: memoryDir,
      imported: 1,
    });
    expect(self().countEntries()).toBe(4);
    expect(await post('?none=1')).toMatchObject({
      state: 'complete',
      source: null,
      imported: 0,
    });
  });

  // Import again, with nothing found where Claude keeps notes, keeps the
  // owner's earlier answer instead of asking again.
  it('a plain re-run after --from or --none keeps that answer', async () => {
    const elsewhere = join(fakeHome, 'notes');
    renameSync(memoryDir, elsewhere);
    const post = async (query = '') =>
      (
        (await (
          await fetch(`${base}/api/memory/import/claude${query}`, {
            method: 'POST',
          })
        ).json()) as { report: Record<string, unknown> }
      ).report;
    const state = () => self().meta(`claude-import:${projectKeyOf(root)}`);
    expect(await post(`?from=${encodeURIComponent(elsewhere)}`)).toMatchObject({
      state: 'complete',
      source: elsewhere,
    });
    writeFileSync(join(elsewhere, 'later.md'), 'a note written later');
    expect(await post()).toMatchObject({
      state: 'complete',
      source: elsewhere,
      imported: 1,
    });
    expect(await post('?none=1')).toMatchObject({ state: 'complete' });
    expect(await post()).toMatchObject({ state: 'complete', source: null });
    expect(state()).toBe('complete');
  });

  it('overflows long project notes into the owner’s personal doc, and recovers ones cut before docs, once (docs Task 18)', async () => {
    const key = projectKeyOf(root);
    expect(self().meta(`claude-import-overflow:${key}`)).toBe('done');
    const long = `---\nname: long\ndescription: long project note\nmetadata:\n  type: project\n---\n${'line of text\n'.repeat(1000)}`;
    writeFileSync(join(memoryDir, 'long.md'), long);
    const res = await fetch(`${base}/api/memory/import/claude`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const entry = self()
      .listEntries()
      .find((e) => e.title === 'long project note');
    const docRef = entry?.refs.find((r) => r.type === 'doc');
    expect(entry?.body).toMatch(
      new RegExp(`full text in doc ${docRef?.id} of project ${key}\\]$`)
    );
    const doc = await fetch(`${base}/api/docs/${docRef?.id}`);
    expect(doc.status).toBe(200);
    const read = (await doc.json()) as { doc: { scope: string }; text: string };
    expect(read.doc.scope).toBe('personal');
    expect(read.text).toBe('line of text\n'.repeat(1000).trimEnd());
    const ada = handle.team.teammates.issue('ada', 'decide');
    const theirs = await fetch(`${base}/api/docs/${docRef?.id}`, {
      headers: { authorization: `Bearer ${ada}` },
    });
    expect(theirs.status).not.toBe(200);

    // As a build before docs left it: the plain cut, no doc ref, no recovery mark.
    const store = self();
    const plain = parseMemoryFile(long, 'long.md').body;
    if (entry === undefined) throw new Error('no entry');
    store.updateEntry(
      { ...entry, body: plain, refs: [], rev: entry.rev + 1 },
      'agent:wyat/claude-code',
      'import'
    );
    store.deleteMeta(`claude-import-overflow:${key}`);
    await handle.stop();
    await boot();
    const deadline = Date.now() + 4000;
    while (
      self().meta(`claude-import-overflow:${key}`) !== 'done' &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 20));
    const recovered = self().getEntry(entry.id);
    expect(recovered?.body).toMatch(/full text in doc doc-/);
    expect(recovered?.refs.some((r) => r.type === 'doc')).toBe(true);
  });
});
