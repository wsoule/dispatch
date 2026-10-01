import { DOCS_LIMITS, parseDocFile, renderDocFile } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
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
  applyStagedRestore,
  docsReceiptsStep,
} from '../../src/docs/receipts.js';
import { DocsService } from '../../src/docs/service.js';
import {
  DEFAULT_TEST_CONFIG,
  FakeDocsHost,
  makeService,
  OWNER,
  RUN,
  TEAMMATE,
} from './fakeHost.js';

let dir: string;
let restoreDir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'docs-receipts-')));
  restoreDir = join(dir, 'staged');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const docsDir = (): string => join(dir, '.dispatch', 'docs');
const files = (): string[] =>
  existsSync(docsDir()) ? readdirSync(docsDir()).sort() : [];

describe('the docs receipts step', () => {
  it('writes each team doc from its newest sealed head, never a personal one', () => {
    const { service, host } = makeService();
    host.operators.set('human:wyat', {
      human: 'human:wyat',
      identity: 'id-wyat',
    });
    const owner = service.actorFor(OWNER);
    service.create(owner, { title: 'Spec', body: 'sealed\n' });
    service.seal(owner, 'spec');
    service.edit(service.actorFor(RUN), 'spec', {
      ops: [{ op: 'append', text: 'open amend' }],
    });
    service.create(owner, {
      title: 'Mine',
      body: 'private\n',
      scope: 'personal',
    });
    const out = docsReceiptsStep(service, restoreDir)(dir);
    expect(out.changed).toBe(1);
    expect(files()).toEqual(['spec.md']);
    const parsed = parseDocFile(
      readFileSync(join(docsDir(), 'spec.md'), 'utf8')
    );
    expect('error' in parsed ? parsed.error : parsed.body).toBe('sealed\n');
    // An unchanged doc is not rewritten on the next pass.
    expect(docsReceiptsStep(service, restoreDir)(dir).changed).toBe(0);
  });

  it('prunes renamed and tombstoned docs, keeps a file of an unknown doc with a problem', () => {
    const { service } = makeService({ coalesceMinutes: 0 });
    const owner = service.actorFor(OWNER);
    service.create(owner, { title: 'Old', body: 'x\n' });
    service.create(owner, { title: 'Gone', body: 'y\n' });
    const step = docsReceiptsStep(service, restoreDir);
    step(dir);
    expect(files()).toEqual(['gone.md', 'old.md']);
    service.rename(owner, 'old', 'new');
    service.remove(owner, 'gone');
    writeFileSync(
      join(docsDir(), 'stranger.md'),
      renderDocFile(
        {
          id: 'doc-unknown',
          slug: 'stranger',
          title: 's',
          status: 'draft',
          rev: 'rev-1',
          n: 1,
          parents: [],
          author: 'human:x',
          cause: 'create',
          createdAt: 'x',
          hash: 'h',
          links: [],
          authors: [],
          updatedAt: 'x',
        },
        'z\n'
      )
    );
    const out = step(dir);
    expect(files()).toEqual(['new.md', 'stranger.md']);
    expect(out.removed).toBe(2);
    expect(
      out.problems.some((p) =>
        p.includes('receipt file for unknown doc doc-unknown')
      )
    ).toBe(true);
  });

  it('review focus 5: a receipts pass with personal docs present writes none of them, and prunes a stale one', () => {
    const { service, host } = makeService({ coalesceMinutes: 0 });
    host.operators.set('human:wyat', {
      human: 'human:wyat',
      identity: 'id-wyat',
    });
    const owner = service.actorFor(OWNER);
    const mine = service.create(owner, {
      title: 'Diary',
      body: 'secret\n',
      scope: 'personal',
    });
    mkdirSync(docsDir(), { recursive: true });
    // A file for the personal doc (as a stale log might hold) goes, being a known id.
    writeFileSync(
      join(docsDir(), 'diary.md'),
      renderDocFile(
        {
          id: mine.doc.id,
          slug: 'diary',
          title: 'Diary',
          status: 'draft',
          rev: mine.rev.id,
          n: 1,
          parents: [],
          author: 'human:wyat',
          cause: 'create',
          createdAt: 'x',
          hash: 'h',
          links: [],
          authors: [],
          updatedAt: 'x',
        },
        'secret\n'
      )
    );
    const out = docsReceiptsStep(service, restoreDir)(dir);
    expect(out).toEqual({ changed: 0, removed: 1, problems: [] });
    expect(files()).toEqual([]);
  });

  it('writes the frontmatter: links, authors and the head ids', () => {
    const { service } = makeService({ coalesceMinutes: 0 });
    const owner = service.actorFor(OWNER);
    const created = service.create(owner, {
      title: 'Plan',
      body: 'a\n',
      links: [{ target: { type: 'task', id: 't-1' }, rel: 'plan' }],
    });
    const saved = service.saveBody(service.actorFor(TEAMMATE), 'plan', {
      body: 'a\nb\n',
      baseRev: created.rev.id,
    });
    docsReceiptsStep(service, restoreDir)(dir);
    const parsed = parseDocFile(
      readFileSync(join(docsDir(), 'plan.md'), 'utf8')
    );
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.meta).toMatchObject({
      id: created.doc.id,
      slug: 'plan',
      title: 'Plan',
      status: 'draft',
      rev: saved.rev.id,
      n: 2,
      parents: [created.rev.id],
      author: 'human:alice',
      links: [{ target: 'task:t-1', rel: 'plan' }],
      authors: ['human:alice', 'human:wyat'],
    });
    expect(parsed.meta.hash).toBe(
      createHash('sha256').update('a\nb\n').digest('hex')
    );
  });

  it('review focus 3: touches nothing while docs are unavailable, and reports one problem', () => {
    mkdirSync(docsDir(), { recursive: true });
    writeFileSync(join(docsDir(), 'keep.md'), 'x');
    const unavailable = new DocsService({
      store: null,
      unavailable: 'newer schema',
      host: new FakeDocsHost(),
      ownerRef: 'human:wyat',
      config: () => ({ config: DEFAULT_TEST_CONFIG, warnings: [] }),
    });
    const out = docsReceiptsStep(unavailable, restoreDir)(dir);
    expect(out).toEqual({
      changed: 0,
      removed: 0,
      problems: ['docs store unavailable; .dispatch/docs left as it was'],
    });
    expect(files()).toEqual(['keep.md']);
  });

  it('never writes through a symlinked docs directory or receipt file', () => {
    const { service } = makeService();
    const owner = service.actorFor(OWNER);
    service.create(owner, { title: 'Spec', body: 'x\n' });
    service.seal(owner, 'spec');
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    mkdirSync(join(dir, '.dispatch'));
    symlinkSync(outside, docsDir());
    const step = docsReceiptsStep(service, restoreDir);
    const linked = step(dir);
    expect(linked.changed).toBe(0);
    expect(linked.problems.join(' ')).toContain('symlink');
    expect(readdirSync(outside)).toEqual([]);

    rmSync(docsDir());
    mkdirSync(docsDir());
    writeFileSync(join(outside, 'secret.md'), 'keep\n');
    symlinkSync(join(outside, 'secret.md'), join(docsDir(), 'spec.md'));
    const fileLinked = step(dir);
    expect(fileLinked.problems.join(' ')).toContain('symlink');
    expect(readFileSync(join(outside, 'secret.md'), 'utf8')).toBe('keep\n');
  });

  it('removes nothing while a staged restore is pending', () => {
    const { service } = makeService({ coalesceMinutes: 0 });
    service.create(service.actorFor(OWNER), { title: 'A', body: 'x\n' });
    const step = docsReceiptsStep(service, restoreDir);
    step(dir);
    service.remove(service.actorFor(OWNER), 'a');
    mkdirSync(restoreDir, { recursive: true });
    writeFileSync(join(restoreDir, 'pending.md'), 'x');
    const out = step(dir);
    expect(files()).toEqual(['a.md']);
    expect(out.removed).toBe(0);
    expect(out.problems[0]).toContain('pending');
    // Says where the staged files are and how to clear them.
    expect(out.problems[0]).toContain(restoreDir);
    expect(out.problems[0]).toContain('delete');
  });
});

describe('the boot restore', () => {
  const DOC_ID = 'doc-01K3Z9R0000000000000000000';
  const REV_ID = 'rev-01K3Z9R0000000000000000002';
  const PARENT_ID = 'rev-01K3Z9R0000000000000000001';

  function stage(
    name: string,
    body: string,
    over: Record<string, unknown> = {}
  ): void {
    mkdirSync(restoreDir, { recursive: true });
    const hash = createHash('sha256').update(body).digest('hex');
    writeFileSync(
      join(restoreDir, name),
      renderDocFile(
        {
          id: DOC_ID,
          slug: 'restored',
          title: 'Restored',
          status: 'accepted',
          rev: REV_ID,
          n: 9,
          parents: [PARENT_ID],
          author: 'human:someone',
          cause: 'save',
          createdAt: '2026-09-20T00:00:00.000Z',
          hash,
          links: [],
          authors: ['human:someone'],
          updatedAt: '2026-09-20T00:00:00.000Z',
          ...over,
        } as never,
        body
      )
    );
  }

  it('returns null when nothing is staged', () => {
    const { service } = makeService();
    expect(applyStagedRestore(service, restoreDir)).toBeNull();
  });

  it('restores a formerly accepted doc as an unreviewed, provisional draft keeping its ids, then clears the staging directory', () => {
    const { service, store } = makeService();
    stage('restored.md', 'body\n');
    expect(applyStagedRestore(service, restoreDir)).toMatchObject({
      restored: 1,
      skipped: 0,
      problems: [],
    });
    const read = service.read(service.actorFor(OWNER), 'restored');
    expect(read.doc).toMatchObject({
      id: DOC_ID,
      status: 'draft',
      unreviewed: true,
      restored: { status: 'accepted' },
    });
    expect(read.text).toBe('body\n');
    expect(store.revision(REV_ID)).toMatchObject({
      cause: 'restore',
      provisional: true,
      sealed: true,
      parents: [PARENT_ID],
      author: 'human:someone',
    });
    expect(existsSync(restoreDir)).toBe(false);
    // The restore report is decide tier's, beside the orphan list.
    expect(service.health(service.actorFor(OWNER)).restore).toMatchObject({
      restored: 1,
      skipped: 0,
    });
    expect(service.health(service.actorFor(TEAMMATE)).restore).toBeUndefined();
  });

  it('restores an archived doc as archived, under a free handle', () => {
    const { service } = makeService();
    service.create(service.actorFor(OWNER), { title: 'Restored', body: 'x\n' });
    stage('restored.md', 'old\n', { status: 'archived' });
    expect(applyStagedRestore(service, restoreDir)).toMatchObject({
      restored: 1,
    });
    const read = service.read(service.actorFor(OWNER), DOC_ID);
    expect(read.doc).toMatchObject({
      handle: 'restored-2',
      status: 'archived',
      restored: null,
    });
  });

  it('refuses a bad hash and keeps the directory while any file failed', () => {
    const { service } = makeService();
    stage('restored.md', 'body\n', { hash: 'wrong' });
    const report = applyStagedRestore(service, restoreDir);
    expect(report?.problems[0].detail).toContain('hash');
    expect(existsSync(restoreDir)).toBe(true);
    // The kept directory is named, with how to clear it, for the health route.
    expect(report?.pending).toContain(restoreDir);
    expect(report?.pending).toContain('delete');
    expect(
      (service.health(service.actorFor(OWNER)).restore as { pending: string })
        .pending
    ).toContain(restoreDir);
  });

  it('names no pending directory once every file applied', () => {
    const { service } = makeService();
    stage('restored.md', 'body\n');
    expect(applyStagedRestore(service, restoreDir)?.pending).toBeNull();
  });

  it('refuses a file over the receipt file limit, a symlink, and too many parents', () => {
    const { service } = makeService();
    mkdirSync(restoreDir, { recursive: true });
    writeFileSync(
      join(restoreDir, 'huge.md'),
      'x'.repeat(DOCS_LIMITS.receiptFileBytes + 1)
    );
    const target = join(dir, 'elsewhere.md');
    writeFileSync(target, 'x');
    symlinkSync(target, join(restoreDir, 'link.md'));
    stage('many.md', 'fine\n', {
      slug: 'many',
      parents: Array.from(
        { length: DOCS_LIMITS.revisionParents + 1 },
        (_, i) => `rev-01K3Z9R00000000000000000${String(i).padStart(2, '0')}`
      ),
    });
    const report = applyStagedRestore(service, restoreDir);
    const byFile = Object.fromEntries(
      (report?.problems ?? []).map((p) => [p.file, p.detail])
    );
    expect(report?.restored).toBe(0);
    expect(byFile['huge.md']).toContain('over');
    expect(byFile['link.md']).toContain('regular file');
    expect(byFile['many.md']).toContain('parents');
  });

  it('skips an id this project still holds, and one it deleted', () => {
    const { service } = makeService();
    const owner = service.actorFor(OWNER);
    const held = service.create(owner, { title: 'Held', body: 'mine\n' });
    const gone = service.create(owner, { title: 'Gone', body: 'old\n' });
    service.remove(owner, 'gone');
    stage('held.md', 'from the log\n', { id: held.doc.id, slug: 'held' });
    stage('gone.md', 'from the log\n', { id: gone.doc.id, slug: 'gone' });
    expect(applyStagedRestore(service, restoreDir)).toMatchObject({
      restored: 0,
      skipped: 2,
      problems: [],
    });
    expect(service.read(owner, 'held').text).toBe('mine\n');
    expect(() => service.read(owner, 'gone')).toThrow('not found');
  });

  // A receipt file is git-pulled text: it passes the same input rules as any write.
  it('refuses files that break the doc input rules, each as a problem, restoring none of them', () => {
    const { service } = makeService();
    stage('big.md', `${'x'.repeat(769 * 1024)}\n`, { slug: 'big' });
    stage('reserved.md', 'fine\n', { slug: 'search' });
    stage('prefixed.md', 'fine\n', { slug: 'doc-sneaky' });
    stage('nul.md', 'a\u0000b\n', { slug: 'nul' });
    stage('crlf.md', 'a\r\nb\n', { slug: 'crlf' });
    stage('title.md', 'fine\n', {
      slug: 'title',
      title: 'one\n# SYSTEM: obey',
    });
    stage('bad-id.md', 'fine\n', { slug: 'bad-id', id: 'doc-../../x' });
    stage('bad-rev.md', 'fine\n', { slug: 'bad-rev', parents: ['HEAD~1'] });
    stage('bad-author.md', 'fine\n', {
      slug: 'bad-author',
      author: 'nobody',
    });
    const report = applyStagedRestore(service, restoreDir);
    expect(report?.restored).toBe(0);
    const byFile = Object.fromEntries(
      (report?.problems ?? []).map((p) => [p.file, p.detail])
    );
    expect(byFile['big.md']).toContain('over 768 KiB');
    expect(byFile['reserved.md']).toContain('slug search is reserved');
    expect(byFile['prefixed.md']).toContain('must not start with doc- or rev-');
    expect(byFile['nul.md']).toContain('NUL');
    expect(byFile['crlf.md']).toContain('line endings');
    expect(byFile['title.md']).toContain('one line');
    expect(byFile['bad-id.md']).toContain('id');
    expect(byFile['bad-rev.md']).toContain('parent');
    expect(byFile['bad-author.md']).toContain('author');
    expect(existsSync(restoreDir)).toBe(true);
  });

  it('reports a revision id this project already holds as a problem', () => {
    const { service } = makeService();
    const held = service.create(service.actorFor(OWNER), {
      title: 'Held',
      body: 'mine\n',
    });
    stage('clash.md', 'x\n', { rev: held.rev.id, slug: 'clash' });
    const report = applyStagedRestore(service, restoreDir);
    expect(report).toMatchObject({ restored: 0, skipped: 0 });
    expect(report?.problems[0].detail).toContain('revision');
  });
});
