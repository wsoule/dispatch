import { MEMORY_RECEIPT_FILE_BYTES } from '@dispatch/core';
import {
  createMemoryIds,
  newMemoryEntry,
  renderReceiptFile,
} from '@dispatch/memory';
import type { MemoryEntry, MemoryScope } from '@dispatch/memory';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyStagedMemoryRestore,
  memoryReceiptsStep,
} from '../../src/memory/receipts.js';
import { isReceiptEvent } from '../../src/receipts/scheduler.js';
import { testEngine } from '../memory/fixtures.js';

let dir: string;
let restoreDir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'memory-receipts-')));
  restoreDir = join(dir, 'staged');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ids = createMemoryIds();
const memoryDir = (): string => join(dir, '.dispatch', 'memory');
const files = (): string[] =>
  existsSync(memoryDir()) ? readdirSync(memoryDir()).sort() : [];

// An entry of `scope` written straight into `t.shared`, as a human's save leaves it.
function seed(
  t: ReturnType<typeof testEngine>,
  scope: MemoryScope,
  title: string,
  over: Partial<MemoryEntry> = {}
): MemoryEntry {
  const entry = {
    ...newMemoryEntry(
      {
        scope,
        kind: 'hazard',
        title,
        body: `${title} body`,
        author: 'human:wyat',
        trust: 'human',
      },
      ids.entry(Date.now()),
      new Date().toISOString()
    ),
    ...over,
  };
  t.shared.insertEntry(entry, 'human:wyat', 'save');
  return entry;
}

describe('the memory receipts step', () => {
  it('exports each team entry as memory/<id>.md and never reads it back', () => {
    const t = testEngine();
    const e = seed(t, 'team', 'pnpm 11 ignores onlyBuiltDependencies');
    const step = memoryReceiptsStep(() => t.shared, restoreDir);
    expect(step(dir)).toEqual({ changed: 1, removed: 0, problems: [] });
    const path = join(memoryDir(), `${e.id}.md`);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain(`> Dispatch memory ${e.handle} · team hazard`);
    expect(text).toContain('pnpm 11 ignores onlyBuiltDependencies body');
    expect(step(dir).changed).toBe(0);
    rmSync(path);
    expect(step(dir).changed).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(text);
    // An edited receipt changes nothing in memory.db and is written over.
    writeFileSync(path, text.replace('body', 'forged'));
    expect(step(dir).changed).toBe(1);
    expect(t.shared.getEntry(e.id)?.body).toBe(e.body);
    expect(t.shared.revisions(e.id)).toHaveLength(1);
    expect(readFileSync(path, 'utf8')).toBe(text);
  });

  it('never exports personal or project entries', () => {
    const t = testEngine();
    const team = seed(t, 'team', 'team lesson');
    seed(t, 'project', 'project lesson');
    seed(t, 'personal', 'my own lesson');
    memoryReceiptsStep(() => t.shared, restoreDir)(dir);
    expect(files()).toEqual([`${team.id}.md`]);
  });

  it('a retired team entry is exported with its status', () => {
    const t = testEngine();
    const e = seed(t, 'team', 'old lesson', {
      status: 'retired',
      statusReason: 'superseded',
    });
    memoryReceiptsStep(() => t.shared, restoreDir)(dir);
    expect(readFileSync(join(memoryDir(), `${e.id}.md`), 'utf8')).toContain(
      '    status: retired (superseded)\n'
    );
  });

  it('removes a file only for an entry it exported, and names an unknown one', () => {
    const t = testEngine();
    const gone = seed(t, 'team', 'hard deleted');
    const kept = seed(t, 'team', 'kept');
    const step = memoryReceiptsStep(() => t.shared, restoreDir);
    step(dir);
    t.shared.deleteEntry(gone.id, 'human:wyat', new Date().toISOString());
    const stranger = 'mem-01K00000000000000000000000.md';
    writeFileSync(join(memoryDir(), stranger), 'from a lost memory.db\n');
    const out = step(dir);
    expect(out.removed).toBe(1);
    expect(out.problems).toEqual([
      `receipt file ${stranger} was not written from this memory.db; kept. Delete it once no longer needed`,
    ]);
    expect(files()).toEqual([`${kept.id}.md`, stranger].sort());
  });

  it('owns a file whose id a restored entry or an approved or rejected restore proposal names', async () => {
    const t = testEngine();
    t.host.raise = () => Promise.resolve('m-gate');
    const approved = 'mem-01K00000000000000000000001';
    const rejected = 'mem-01K00000000000000000000002';
    const waiting = 'mem-01K00000000000000000000003';
    const expired = 'mem-01K00000000000000000000004';
    const restoredEntry = seed(t, 'team', 'restored', {
      origin: `receipts:${approved}`,
    });
    const propose = (id: string, title: string) =>
      t.engine.submitProposal(
        { address: 'agent:dispatch', canDecide: false, kind: 'agent' },
        {
          action: 'add',
          scope: 'team',
          content: {
            scope: 'team',
            kind: 'fact',
            title,
            body: title,
            refs: [],
            epic: null,
            appliesTo: [],
            projectKey: null,
          },
          origin: `receipts:${id}`,
        }
      );
    const no = (await propose(rejected, 'rejected')) as { proposal: string };
    t.engine.applyGateAnswer({
      proposalId: no.proposal,
      gateId: 'm-gate',
      choice: 'reject',
      by: 'human:wyat',
      reason: '',
      expired: false,
    });
    await propose(waiting, 'waiting');
    const lapsed = (await propose(expired, 'expired')) as { proposal: string };
    t.engine.applyGateAnswer({
      proposalId: lapsed.proposal,
      gateId: 'm-gate',
      choice: 'reject',
      by: 'agent:dispatch',
      reason: '',
      expired: true,
    });
    mkdirSync(memoryDir(), { recursive: true });
    for (const id of [approved, rejected, waiting, expired])
      writeFileSync(join(memoryDir(), `${id}.md`), 'from the old log\n');
    const out = memoryReceiptsStep(() => t.shared, restoreDir)(dir);
    expect(out.removed).toBe(2);
    expect(out.problems).toHaveLength(2);
    expect(files()).toEqual(
      [`${restoredEntry.id}.md`, `${waiting}.md`, `${expired}.md`].sort()
    );
  });

  it('keeps unknown files while a restore is staged, but still prunes its own', () => {
    const t = testEngine();
    const gone = seed(t, 'team', 'hard deleted secret');
    const step = memoryReceiptsStep(() => t.shared, restoreDir);
    step(dir);
    t.shared.deleteEntry(gone.id, 'human:wyat', new Date().toISOString());
    const stranger = 'mem-01K00000000000000000000000.md';
    writeFileSync(join(memoryDir(), stranger), 'from the old log\n');
    mkdirSync(restoreDir);
    writeFileSync(join(restoreDir, stranger), 'staged\n');
    const out = step(dir);
    expect(out.removed).toBe(1);
    expect(out.problems).toEqual([
      `a staged memory restore is pending (${stranger}); files this memory.db did not write are kept until it is applied`,
    ]);
    expect(files()).toEqual([stranger]);
  });

  it('leaves the log as it was while memory.db is unavailable', () => {
    mkdirSync(memoryDir(), { recursive: true });
    writeFileSync(join(memoryDir(), 'x.md'), 'kept\n');
    const out = memoryReceiptsStep(() => null, restoreDir)(dir);
    expect(out).toEqual({
      changed: 0,
      removed: 0,
      problems: ['memory store unavailable; .dispatch/memory left as it was'],
    });
    expect(files()).toEqual(['x.md']);
  });
});

describe('a staged memory restore', () => {
  // An engine whose gates are sent, so each open proposal records one.
  function gatedEngine(): ReturnType<typeof testEngine> {
    const t = testEngine();
    t.host.raise = () => Promise.resolve('m-gate');
    return t;
  }

  // Writes `entry`'s receipt file into the staging directory, as the CLI copies it.
  function stage(entry: MemoryEntry, text = renderReceiptFile(entry)): string {
    mkdirSync(restoreDir, { recursive: true });
    const file = `${entry.id}.md`;
    writeFileSync(join(restoreDir, file), text);
    return file;
  }

  function lostEntry(title: string, kind: MemoryEntry['kind'] = 'decision') {
    return newMemoryEntry(
      {
        scope: 'team',
        kind,
        title,
        body: `${title}\nsecond line`,
        author: 'human:wyat',
        trust: 'human',
      },
      ids.entry(Date.now()),
      new Date().toISOString()
    );
  }

  it('comes back as open agent proposals, never as entries', async () => {
    const t = gatedEngine();
    const lost = lostEntry('use allowBuilds');
    stage(lost);
    const report = await applyStagedMemoryRestore(
      t.engine,
      t.shared,
      restoreDir
    );
    expect(report).toMatchObject({ restored: 1, skipped: 0, problems: [] });
    expect(t.shared.countEntries()).toBe(0);
    const [p] = t.shared.listProposals({ states: ['open'] });
    expect(p).toMatchObject({
      action: 'add',
      scope: 'team',
      author: 'agent:dispatch',
      authorTrust: 'agent',
      origin: `receipts:${lost.id}`,
    });
    expect(p.content).toMatchObject({
      kind: 'decision',
      title: lost.title,
      body: lost.body,
    });
    expect(existsSync(restoreDir)).toBe(false);
    // Nothing staged is nothing to report.
    expect(
      await applyStagedMemoryRestore(t.engine, t.shared, restoreDir)
    ).toBeNull();
  });

  it('always waits for a human, whatever the auto policy', async () => {
    const t = gatedEngine();
    t.host.ruling = {
      mode: 'auto',
      gate: 'memory',
      rung: 4,
      authorizedBy: 'rung',
    };
    stage(lostEntry('not auto approved'));
    await applyStagedMemoryRestore(t.engine, t.shared, restoreDir);
    expect(t.shared.countEntries()).toBe(0);
    const [p] = t.shared.listProposals({ states: ['open'] });
    expect(p.gate).toBe('m-gate');
  });

  it('proposes at most the per-boot limit and leaves the rest staged', async () => {
    const t = gatedEngine();
    const lost = ['one', 'two', 'three'].map((n) => lostEntry(n));
    for (const e of lost) stage(e);
    const first = await applyStagedMemoryRestore(
      t.engine,
      t.shared,
      restoreDir,
      2
    );
    expect(first).toMatchObject({ restored: 2, deferred: 1, problems: [] });
    expect(first?.pending).toContain(restoreDir);
    expect(readdirSync(restoreDir)).toEqual([`${lost[2].id}.md`]);
    const second = await applyStagedMemoryRestore(
      t.engine,
      t.shared,
      restoreDir,
      2
    );
    expect(second).toMatchObject({ restored: 1, deferred: 0, pending: null });
    expect(existsSync(restoreDir)).toBe(false);
    expect(t.shared.listProposals()).toHaveLength(3);
  });

  it('proposes at most 50 by default', async () => {
    const t = gatedEngine();
    const lost = Array.from({ length: 51 }, (_, i) => lostEntry(`lesson ${i}`));
    for (const e of lost) stage(e);
    const report = await applyStagedMemoryRestore(
      t.engine,
      t.shared,
      restoreDir
    );
    expect(report).toMatchObject({ restored: 50, deferred: 1, problems: [] });
    expect(t.shared.listProposals()).toHaveLength(50);
    expect(readdirSync(restoreDir)).toHaveLength(1);
  });

  it('removes only the files it handled, never one staged meanwhile', async () => {
    const t = gatedEngine();
    const late = lostEntry('staged during the pass');
    t.host.raise = () => {
      stage(late);
      return Promise.resolve('m-gate');
    };
    stage(lostEntry('first'));
    const report = await applyStagedMemoryRestore(
      t.engine,
      t.shared,
      restoreDir
    );
    expect(report?.restored).toBe(1);
    expect(readdirSync(restoreDir)).toEqual([`${late.id}.md`]);
    expect(report?.pending).toContain(restoreDir);
  });

  it('skips a retired receipt', async () => {
    const t = gatedEngine();
    const old = lostEntry('superseded lesson');
    stage({ ...old, status: 'retired', statusReason: 'superseded' });
    const report = await applyStagedMemoryRestore(
      t.engine,
      t.shared,
      restoreDir
    );
    expect(report).toMatchObject({ restored: 0, skipped: 1, problems: [] });
    expect(t.shared.listProposals()).toEqual([]);
  });

  it('skips an entry this store holds, or a restore it already made', async () => {
    const t = gatedEngine();
    const held = seed(t, 'team', 'held');
    const lost = lostEntry('restored once');
    stage(held);
    stage(lost);
    await applyStagedMemoryRestore(t.engine, t.shared, restoreDir);
    stage(lost);
    const again = await applyStagedMemoryRestore(
      t.engine,
      t.shared,
      restoreDir
    );
    expect(again).toMatchObject({ restored: 0, skipped: 1, problems: [] });
    expect(t.shared.listProposals()).toHaveLength(1);
  });

  it('skips a retired status in any case or spacing, and refuses one that is not a string', async () => {
    const t = gatedEngine();
    const variant = (title: string, line: string) => {
      const e = lostEntry(title);
      stage(e, renderReceiptFile(e).replace('    status: active', line));
      return `${e.id}.md`;
    };
    variant('upper', '    status: Retired');
    variant('spaced', '    status: " retired"');
    const list = variant('list', '    status: [retired]');
    const twice = variant('twice', '    status: active\n    status: retired');
    const report = await applyStagedMemoryRestore(
      t.engine,
      t.shared,
      restoreDir
    );
    expect(report).toMatchObject({ restored: 0, skipped: 2 });
    expect(report?.problems.map((p) => p.file).sort()).toEqual(
      [list, twice].sort()
    );
    expect(t.shared.listProposals()).toEqual([]);
  });

  it('proposes again a restore whose proposal expired undecided', async () => {
    const t = gatedEngine();
    const lost = lostEntry('expired once');
    stage(lost);
    await applyStagedMemoryRestore(t.engine, t.shared, restoreDir);
    const [first] = t.shared.listProposals();
    t.engine.applyGateAnswer({
      proposalId: first.id,
      gateId: 'm-gate',
      choice: 'reject',
      by: 'agent:dispatch',
      reason: '',
      expired: true,
    });
    stage(lost);
    const again = await applyStagedMemoryRestore(
      t.engine,
      t.shared,
      restoreDir
    );
    expect(again).toMatchObject({ restored: 1, skipped: 0, problems: [] });
    const open = t.shared.listProposals({ states: ['open'] });
    expect(open).toHaveLength(1);
    expect(open[0].origin).toStartWith(`receipts:${lost.id}`);
    // A third staging finds the open retry and skips.
    stage(lost);
    expect(
      await applyStagedMemoryRestore(t.engine, t.shared, restoreDir)
    ).toMatchObject({ restored: 0, skipped: 1 });
  });

  it('refuses symlinks, oversized files, foreign names and broken input, and keeps the staging', async () => {
    const t = gatedEngine();
    const good = lostEntry('good');
    stage(good);
    mkdirSync(restoreDir, { recursive: true });
    const secret = join(dir, 'secret.md');
    writeFileSync(secret, 'not a receipt\n');
    const link = lostEntry('link');
    symlinkSync(secret, join(restoreDir, `${link.id}.md`));
    const huge = lostEntry('huge');
    stage(huge, 'x'.repeat(MEMORY_RECEIPT_FILE_BYTES + 1));
    writeFileSync(join(restoreDir, 'notes.md'), 'a stray file\n');
    const long = lostEntry('long');
    stage(long, renderReceiptFile({ ...long, body: 'y'.repeat(9000) }));
    const report = await applyStagedMemoryRestore(
      t.engine,
      t.shared,
      restoreDir
    );
    expect(report?.restored).toBe(1);
    expect(report?.problems.map((p) => [p.file, p.detail]).sort()).toEqual(
      [
        [`${link.id}.md`, 'not a regular file'],
        [`${huge.id}.md`, `over ${MEMORY_RECEIPT_FILE_BYTES} bytes`],
        ['notes.md', 'not a memory receipt file name'],
        [`${long.id}.md`, 'body: over the 8192-byte limit'],
      ].sort()
    );
    expect(report?.pending).toContain(restoreDir);
    expect(existsSync(restoreDir)).toBe(true);
    expect(t.shared.listProposals()).toHaveLength(1);
  });
});

describe('isReceiptEvent for memory', () => {
  it('covers team memory changes only', () => {
    expect(isReceiptEvent({ type: 'memory.changed', scope: 'team' })).toBe(
      true
    );
    expect(isReceiptEvent({ type: 'memory.changed', scope: 'project' })).toBe(
      false
    );
    expect(isReceiptEvent({ type: 'memory.changed', scope: 'personal' })).toBe(
      false
    );
  });
});
