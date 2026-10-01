import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  publishAssetsDir,
  seedAsset,
  seedFile,
  validatePublishPath,
} from '../../src/docs/publish.js';
import type { DocsService } from '../../src/docs/service.js';
import type { SqliteDocStore } from '../../src/docs/store.js';
import type { FakeDocsHost } from './fakeHost.js';
import { AGENT, makeService, OWNER, RUN, TEAMMATE } from './fakeHost.js';

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}
let root: string;
beforeEach(() => {
  root = tempDir('docs-publish-');
});
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('validatePublishPath', () => {
  it('accepts a repo-relative markdown path', () => {
    expect(validatePublishPath(root, 'docs/specs/auth.md')).toBe(
      'docs/specs/auth.md'
    );
    expect(validatePublishPath(root, 'README-auth.md')).toBe('README-auth.md');
  });

  it('refuses traversal, refused trees in any case, instruction files and odd bytes', () => {
    const bad = [
      '',
      '/etc/x.md',
      '../x.md',
      'docs/../../x.md',
      'docs/./x.md',
      'docs//x.md',
      'docs\\x.md',
      'docs/x.txt',
      'docs/x.md/',
      '.github/workflows/ci.md',
      '.GitHub/x.md',
      '.agents/ignore/x.md',
      '.claude/x.md',
      '.dispatch/x.md',
      '.git/x.md',
      'vendor/.git/x.md',
      'sub/.GIT/x.md',
      'AGENTS.md',
      'docs/Claude.md',
      'sub/claude.MD',
      'docs/a\u0000.md',
      'docs/a\nb.md',
      'docs/*.md',
      'docs/[a].md',
      'docs/a?.md',
      'docs/{a,b}.md',
      'docs/a+(b).md',
      '!docs/a.md',
      'AGENT\u017f.md',
      '.agent\u017f/x.md',
      '.di\u017fpatch/x.md',
      'docs/na\u00efve.md',
      'docs/.claude/x.md',
      'a/.github/workflows/x.md',
      'x/.agents/y.md',
      'z/.Dispatch/q.md',
      'AGENTS.override.md',
      'docs/agents.OVERRIDE.md',
      'CLAUDE.local.md',
      'docs/claude.LOCAL.md',
      ':docs/x.md',
      ':x.md',
      `docs/${'a'.repeat(1100)}.md`,
    ];
    for (const path of bad) {
      expect(() => validatePublishPath(root, path)).toThrow();
    }
  });

  it('refuses a path through a symlink, or onto one', () => {
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'link'));
    expect(() => validatePublishPath(root, 'link/x.md')).toThrow('symlink');
    writeFileSync(join(root, 'real', 'target.md'), 'x');
    symlinkSync(join(root, 'real', 'target.md'), join(root, 'real', 'x.md'));
    expect(() => validatePublishPath(root, 'real/x.md')).toThrow('symlink');
  });
});

describe('seedFile', () => {
  it('writes the body, creating its directories', () => {
    seedFile(root, 'docs/deep/a.md', 'body\n');
    expect(readFileSync(join(root, 'docs/deep/a.md'), 'utf8')).toBe('body\n');
    seedFile(root, 'docs/deep/a.md', 'again\n');
    expect(readFileSync(join(root, 'docs/deep/a.md'), 'utf8')).toBe('again\n');
  });

  it('refuses a symlinked directory planted in the worktree, writing nothing outside', () => {
    const outside = tempDir('docs-outside-');
    symlinkSync(outside, join(root, 'evil'));
    expect(() => seedFile(root, 'evil/x.md', 'x')).toThrow('symlink');
    expect(existsSync(join(outside, 'x.md'))).toBe(false);
  });

  it('replaces a symlink at the target itself rather than writing through it', () => {
    const outside = tempDir('docs-outside-');
    writeFileSync(join(outside, 'secret.md'), 'keep\n');
    mkdirSync(join(root, 'docs'));
    symlinkSync(join(outside, 'secret.md'), join(root, 'docs', 'a.md'));
    expect(() => seedFile(root, 'docs/a.md', 'x')).toThrow('symlink');
    expect(readFileSync(join(outside, 'secret.md'), 'utf8')).toBe('keep\n');
  });

  it('refuses a path the publish rules refuse', () => {
    expect(() => seedFile(root, '../x.md', 'x')).toThrow();
    expect(() => seedFile(root, '.github/x.md', 'x')).toThrow();
  });
});

describe('seedAsset', () => {
  const name = `${'c'.repeat(64)}.png`;
  it('writes an image beside the doc, under <stem>.assets/', () => {
    expect(publishAssetsDir('docs/spec.md')).toBe('docs/spec.assets');
    expect(publishAssetsDir('spec.md')).toBe('spec.assets');
    seedAsset(root, 'docs/spec.md', name, new Uint8Array([1, 2]));
    expect(
      new Uint8Array(readFileSync(join(root, 'docs/spec.assets', name)))
    ).toEqual(new Uint8Array([1, 2]));
  });

  it('refuses a bad name, a refused doc path and a symlinked assets directory', () => {
    expect(() =>
      seedAsset(root, 'docs/spec.md', '../x.png', new Uint8Array([1]))
    ).toThrow('asset name');
    expect(() =>
      seedAsset(root, '.github/spec.md', name, new Uint8Array([1]))
    ).toThrow();
    const outside = tempDir('docs-outside-');
    mkdirSync(join(root, 'docs'));
    symlinkSync(outside, join(root, 'docs', 'spec.assets'));
    expect(() =>
      seedAsset(root, 'docs/spec.md', name, new Uint8Array([1]))
    ).toThrow('symlink');
    expect(existsSync(join(outside, name))).toBe(false);
  });
});

describe('publish', () => {
  let service: DocsService;
  let host: FakeDocsHost;
  let store: SqliteDocStore;
  beforeEach(() => {
    ({ service, host, store } = makeService());
    host.rootDir = root;
    host.operators.set('human:wyat', {
      human: 'human:wyat',
      identity: 'id-wyat',
    });
  });
  const as = (p: Parameters<DocsService['actorFor']>[0]) => service.actorFor(p);

  it('creates an elevated publish task with the path as its writes, linked to the doc', () => {
    service.create(as(OWNER), { title: 'Spec', body: '# Spec\n' });
    service.setStatus(as(OWNER), 'spec', 'accepted');
    const out = service.publish(as(TEAMMATE), 'spec', {
      path: 'docs/specs/spec.md',
    });
    const task = host.createdTasks[0];
    expect(task).toMatchObject({
      title: 'Publish doc spec (rev 1) to docs/specs/spec.md',
      writes: ['docs/specs/spec.md'],
      risk: 'elevated',
    });
    expect(out.task).toBe(task.id);
    expect(
      service
        .linking(as(OWNER), { type: 'task', id: task.id })
        .map((l) => [l.doc.handle, l.rel])
    ).toEqual([['spec', 'context']]);
    expect(() =>
      service.publish(as(TEAMMATE), 'spec', { path: 'docs/other.md' })
    ).toThrow(`already publishing: ${task.id}`);
  });

  it('is for humans only, on a reviewed or accepted team doc that is not archived', () => {
    service.create(as(AGENT), { title: 'Agent draft', body: 'x\n' });
    expect(() =>
      service.publish(as(OWNER), 'agent-draft', { path: 'docs/a.md' })
    ).toThrow('review it first');
    service.create(as(OWNER), {
      title: 'Mine',
      body: 'x\n',
      scope: 'personal',
    });
    expect(() =>
      service.publish(as(OWNER), '~mine', { path: 'docs/m.md' })
    ).toThrow('personal docs are never published');
    service.create(as(OWNER), { title: 'Human draft', body: 'x\n' });
    for (const who of [AGENT, RUN]) {
      expect(() =>
        service.publish(as(who), 'human-draft', { path: 'docs/h.md' })
      ).toThrow('humans publish docs');
    }
    expect(() =>
      service.publish(service.overseerActor(), 'human-draft', {
        path: 'docs/h.md',
      })
    ).toThrow('humans publish docs');
    expect(() =>
      service.publish(as(OWNER), 'human-draft', { path: '.github/h.md' })
    ).toThrow('path');
    expect(host.createdTasks).toEqual([]);
    service.setStatus(as(OWNER), 'human-draft', 'archived');
    expect(() =>
      service.publish(as(OWNER), 'human-draft', { path: 'docs/h.md' })
    ).toThrow('archived');
    service.setStatus(as(OWNER), 'human-draft', 'draft');
    expect(
      service.publish(as(OWNER), 'human-draft', { path: 'docs/h.md' }).task
    ).toBeTruthy();
  });

  it('seeds the recorded revision into the run worktree, and records the commit once the task lands', () => {
    service.create(as(OWNER), { title: 'Spec', body: '# Spec v1\n' });
    const { task } = service.publish(as(OWNER), 'spec', {
      path: 'docs/spec.md',
    });
    service.edit(as(OWNER), 'spec', {
      ops: [{ op: 'append', text: 'v2 after publish' }],
    });
    const wt = tempDir('docs-wt-');
    service.seedFor(task, wt);
    expect(readFileSync(join(wt, 'docs/spec.md'), 'utf8')).toBe('# Spec v1\n');
    service.seedFor('t-unrelated', wt);
    expect(service.syncPublishes()).toBe(0);
    host.outcomes.set(task, 'landed');
    host.commits.set('docs/spec.md', 'abc123');
    expect(service.syncPublishes()).toBe(1);
    const doc = service.read(as(OWNER), 'spec').doc;
    expect(doc.published).toEqual({
      path: 'docs/spec.md',
      rev: expect.stringMatching(/^rev-/),
      n: 1,
      task,
      commit: 'abc123',
    });
    expect(doc.head.n).toBe(2);
    expect(store.publishRows({ task })[0].state).toBe('landed');
    expect(service.syncPublishes()).toBe(0);
  });

  it('records no landing for a publish task whose risk was lowered, and refuses to seed it', () => {
    service.create(as(OWNER), { title: 'Spec', body: '# Spec\n' });
    const { task } = service.publish(as(OWNER), 'spec', {
      path: 'docs/spec.md',
    });
    const facts = host.tasks.get(task);
    if (facts === undefined) throw new Error('no publish task');
    host.tasks.set(task, { ...facts, risk: 'routine' });
    const wt = tempDir('docs-wt-');
    expect(() => service.seedFor(task, wt)).toThrow('risk');
    expect(existsSync(join(wt, 'docs/spec.md'))).toBe(false);
    host.outcomes.set(task, 'landed');
    expect(service.syncPublishes()).toBe(0);
    expect(service.read(as(OWNER), 'spec').doc.published).toBeNull();
  });

  it('copies the images the revision references beside it, rewriting their links', () => {
    const assets = tempDir('docs-assets-');
    const withImages = makeService({ assetsDir: assets });
    withImages.host.rootDir = root;
    const svc = withImages.service;
    const owner = svc.actorFor(OWNER);
    svc.create(owner, { title: 'Spec', body: '# Spec\n' });
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9,
    ]);
    const { name, markdown } = svc.putAsset(owner, 'spec', png);
    const ghost = `${'d'.repeat(64)}.png`;
    svc.saveBody(owner, 'spec', {
      baseRev: svc.read(owner, 'spec').rev.id,
      body: `# Spec\n${markdown}\n![gone](asset:${ghost})\n`,
    });
    const { task } = svc.publish(owner, 'spec', { path: 'docs/spec.md' });
    expect(withImages.host.createdTasks[0].writes).toEqual([
      'docs/spec.md',
      'docs/spec.assets/**',
    ]);
    const wt = tempDir('docs-wt-');
    svc.seedFor(task, wt);
    expect(readFileSync(join(wt, 'docs/spec.md'), 'utf8')).toBe(
      `# Spec\n![](spec.assets/${name})\n![gone](asset:${ghost})\n`
    );
    expect(
      new Uint8Array(readFileSync(join(wt, 'docs/spec.assets', name)))
    ).toEqual(png);
  });

  it('marks a landing whose risk was lowered after the seed failed, with the reason, and lets a new publish start', () => {
    service.create(as(OWNER), { title: 'Spec', body: '# Spec\n' });
    const { task } = service.publish(as(OWNER), 'spec', {
      path: 'docs/spec.md',
    });
    service.seedFor(task, tempDir('docs-wt-'));
    const facts = host.tasks.get(task);
    if (facts === undefined) throw new Error('no publish task');
    host.tasks.set(task, { ...facts, risk: 'routine' });
    host.outcomes.set(task, 'landed');
    expect(service.syncPublishes()).toBe(1);
    expect(store.publishRows({ task })[0]).toMatchObject({
      state: 'failed',
      reason: expect.stringContaining('risk was lowered'),
    });
    expect(service.read(as(OWNER), 'spec').doc.published).toBeNull();
    expect(
      service.publish(as(OWNER), 'spec', { path: 'docs/spec.md' }).task
    ).not.toBe(task);
  });

  it('remembers the last path asked for, before the task lands', () => {
    service.create(as(OWNER), { title: 'Spec', body: '# Spec\n' });
    expect(service.read(as(OWNER), 'spec').doc.lastPublishPath).toBeNull();
    service.publish(as(OWNER), 'spec', { path: 'docs/specs/spec.md' });
    expect(service.read(as(OWNER), 'spec').doc.lastPublishPath).toBe(
      'docs/specs/spec.md'
    );
  });

  it('marks the publish failed when its seed throws, and lets a new publish start', () => {
    service.create(as(OWNER), { title: 'Spec', body: '# Spec\n' });
    const { task } = service.publish(as(OWNER), 'spec', {
      path: 'docs/spec.md',
    });
    const wt = tempDir('docs-wt-');
    const outside = tempDir('docs-outside-');
    symlinkSync(outside, join(wt, 'docs'));
    expect(() => service.seedFor(task, wt)).toThrow('symlink');
    expect(store.publishRows({ task })[0].state).toBe('failed');
    expect(existsSync(join(outside, 'spec.md'))).toBe(false);
    // Dispatching the failed task again seeds nothing, so it must not run.
    expect(() => service.seedFor(task, tempDir('docs-wt-'))).toThrow(
      'is failed; publish the doc again'
    );
    expect(
      service.publish(as(OWNER), 'spec', { path: 'docs/spec.md' }).task
    ).not.toBe(task);
  });

  it('records a dropped publish task as dropped, leaving the doc unpublished', () => {
    service.create(as(OWNER), { title: 'Spec', body: '# Spec\n' });
    const { task } = service.publish(as(OWNER), 'spec', {
      path: 'docs/spec.md',
    });
    host.outcomes.set(task, 'dropped');
    expect(service.syncPublishes()).toBe(1);
    expect(store.publishRows({ task })[0].state).toBe('dropped');
    expect(service.read(as(OWNER), 'spec').doc.published).toBeNull();
    expect(service.syncPublishes()).toBe(0);
  });
});
