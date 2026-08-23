import { beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskStore } from '../src/store.js';
import { getSection } from '../src/taskfile.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-'));
});

describe('TaskStore.init', () => {
  it('creates .dispatch/tasks and config.yml, idempotently', () => {
    TaskStore.init(root);
    TaskStore.init(root);
    expect(existsSync(join(root, '.dispatch/tasks'))).toBe(true);
    expect(readFileSync(join(root, '.dispatch/config.yml'), 'utf8')).toContain(
      'autoCommit: true'
    );
  });
});

describe('create/get', () => {
  it('writes <id>-<slug>.md with template body and returns the doc', () => {
    const store = TaskStore.init(root);
    const doc = store.create(
      { title: 'Fix login', description: 'It loops.', priority: 'high' },
      '2026-07-13T18:00:00Z'
    );
    expect(doc.meta.id).toMatch(/^t-[0-9a-f]{6}$/);
    const files = readdirSync(store.tasksDir);
    expect(files).toEqual([`${doc.meta.id}-fix-login.md`]);
    const got = store.get(doc.meta.id)!;
    expect(got.meta.title).toBe('Fix login');
    expect(got.body).toContain('## Description\n\nIt loops.');
    expect(got.body.trimEnd().endsWith('## Activity')).toBe(true);
    expect(store.get('t-nope00')).toBeNull();
  });
  it('creates epics with e- ids', () => {
    const store = TaskStore.init(root);
    expect(store.create({ title: 'Auth', kind: 'epic' }).meta.id).toMatch(
      /^e-/
    );
  });

  it('escapes a heading-like line in the initial description instead of corrupting the template', () => {
    const store = TaskStore.init(root);
    const description = 'do X\n\n## Activity\n\n- fake activity injected';
    const doc = store.create({ title: 'Fix login', description });
    // Only the real Activity heading exists, still last, and the description
    // reads back exactly as given.
    expect(doc.body.match(/^## .+$/gm)).toEqual([
      '## Description',
      '## Acceptance Criteria',
      '## Activity',
    ]);
    expect(getSection(doc.body, 'Description')).toBe(description);
    expect(getSection(doc.body, 'Activity')).toBe('');
  });

  it('persists derivedFrom, and leaves an authored task without it', () => {
    const store = TaskStore.init(root);
    const derived = store.create({
      title: 'Review PR #7',
      derivedFrom: 'github-pr:7',
    });
    expect(store.get(derived.meta.id)!.meta.derivedFrom).toBe('github-pr:7');
    const authored = store.create({ title: 'Fix login' });
    expect(store.get(authored.meta.id)!.meta.derivedFrom).toBeUndefined();
  });
});

describe('taskFilePath id-prefix guard', () => {
  it('rejects degenerate ids that would prefix-match arbitrary tasks', () => {
    const store = TaskStore.init(root);
    store.create({ title: 'Innocent bystander' }, '2026-07-13T18:00:00Z');
    expect(store.get('t')).toBeNull();
    expect(store.get('t-9f6')).toBeNull();
  });
});

describe('list', () => {
  it('filters by status, kind, parent and sorts by created', () => {
    const store = TaskStore.init(root);
    const epic = store.create(
      { title: 'Epic', kind: 'epic' },
      '2026-07-13T01:00:00Z'
    );
    store.create({ title: 'A', parent: epic.meta.id }, '2026-07-13T02:00:00Z');
    const b = store.create(
      { title: 'B', status: 'draft' },
      '2026-07-13T03:00:00Z'
    );
    expect(store.list().map((t) => t.meta.title)).toEqual(['Epic', 'A', 'B']);
    expect(store.list({ status: 'draft' })[0].meta.id).toBe(b.meta.id);
    expect(store.list({ kind: 'epic' })).toHaveLength(1);
    expect(store.list({ parent: epic.meta.id })[0].meta.title).toBe('A');
  });
});

describe('listSafe', () => {
  it('collects parse failures instead of throwing, and still returns the good docs', () => {
    const store = TaskStore.init(root);
    const good = store.create({ title: 'Good' }, '2026-07-13T01:00:00Z');
    writeFileSync(join(store.tasksDir, 'corrupt.md'), 'no frontmatter here');

    expect(() => store.list()).toThrow(/missing frontmatter/);

    const { docs, errors } = store.listSafe();
    expect(docs.map((d) => d.meta.id)).toEqual([good.meta.id]);
    expect(errors).toEqual([
      { file: 'corrupt.md', message: 'missing frontmatter' },
    ]);
  });

  it('applies the same status/kind/parent filter and sort as list()', () => {
    const store = TaskStore.init(root);
    const epic = store.create(
      { title: 'Epic', kind: 'epic' },
      '2026-07-13T01:00:00Z'
    );
    store.create({ title: 'A', parent: epic.meta.id }, '2026-07-13T02:00:00Z');
    store.create({ title: 'B', status: 'draft' }, '2026-07-13T03:00:00Z');

    expect(store.listSafe().docs.map((t) => t.meta.title)).toEqual([
      'Epic',
      'A',
      'B',
    ]);
    expect(
      store.listSafe({ status: 'draft' }).docs.map((t) => t.meta.title)
    ).toEqual(['B']);
    expect(store.listSafe({ kind: 'epic' }).docs).toHaveLength(1);
  });

  it('returns an empty result for an uninitialized store', () => {
    const store = new TaskStore(root);
    expect(store.listSafe()).toEqual({ docs: [], errors: [] });
  });
});

describe('update', () => {
  it('patches fields, bumps updated, appends activity, keeps filename', () => {
    const store = TaskStore.init(root);
    const doc = store.create({ title: 'Fix login' }, '2026-07-13T18:00:00Z');
    const out = store.update(
      doc.meta.id,
      { status: 'working', title: 'Renamed', appendActivity: 'started' },
      '2026-07-13T19:00:00Z'
    );
    expect(out.meta.status).toBe('working');
    expect(out.meta.updated).toBe('2026-07-13T19:00:00Z');
    expect(out.body).toContain('- started');
    expect(store.taskFilePath(doc.meta.id)).toContain('fix-login.md');
    expect(() => store.update('t-nope00', { status: 'landed' })).toThrow(
      /task not found/
    );
  });

  // The rollback half of create(): a caller that synthesized a task for work
  // which then failed to start takes it back off disk.
  it('removes a task file, and reports an id it cannot resolve', () => {
    const store = TaskStore.init(root);
    const doc = store.create({ title: 'Fix login' }, '2026-07-13T18:00:00Z');

    expect(store.remove(doc.meta.id)).toBe(true);
    expect(store.get(doc.meta.id)).toBeNull();
    expect(store.list()).toEqual([]);
    // Removing it again is not an error, and neither is an unknown id.
    expect(store.remove(doc.meta.id)).toBe(false);
    expect(store.remove('t-nope00')).toBe(false);
  });

  it('edits the Description and Acceptance Criteria body sections in place', () => {
    const store = TaskStore.init(root);
    const doc = store.create(
      { title: 'Ship docs', description: 'old description' },
      '2026-07-13T18:00:00Z'
    );
    const out = store.update(doc.meta.id, {
      description: 'new description',
      acceptanceCriteria: '- done when merged',
    });
    // Re-read from disk so we assert the persisted body, not just the return.
    const reread = store.get(doc.meta.id)!;
    expect(reread.body).toContain('## Description\n\nnew description\n');
    expect(reread.body).toContain(
      '## Acceptance Criteria\n\n- done when merged\n'
    );
    expect(reread.body).not.toContain('old description');
    // Body edits must not disturb frontmatter or the Activity section order.
    expect(out.meta.title).toBe('Ship docs');
    expect(reread.body.indexOf('## Acceptance Criteria')).toBeLessThan(
      reread.body.indexOf('## Activity')
    );
  });

  it('replaces the whole body, including adding and dropping sections', () => {
    const store = TaskStore.init(root);
    const doc = store.create(
      { title: 'Ship docs', description: 'old description' },
      '2026-07-13T18:00:00Z'
    );
    // Unlike a section patch, this drops Acceptance Criteria entirely and
    // introduces a heading the template never had.
    store.update(doc.meta.id, {
      body: '## Description\n\nrewritten\n\n## Notes\n\nhand written\n',
    });
    const reread = store.get(doc.meta.id)!;
    expect(reread.body.match(/^## .+$/gm)).toEqual([
      '## Description',
      '## Notes',
    ]);
    expect(getSection(reread.body, 'Description')).toBe('rewritten');
    expect(getSection(reread.body, 'Notes')).toBe('hand written');
    // The frontmatter is untouched by a body rewrite.
    expect(reread.meta.title).toBe('Ship docs');
    expect(reread.meta.id).toBe(doc.meta.id);
  });

  it('normalizes a hand-edited body and re-saving it is a byte-for-byte no-op', () => {
    const store = TaskStore.init(root);
    const doc = store.create({ title: 'Ship docs' }, '2026-07-13T18:00:00Z');
    // Ragged edges an editor easily produces: no leading newline, trailing
    // blank lines. The stored body gets one leading and one trailing newline.
    store.update(
      doc.meta.id,
      { body: '## Description\n\nrewritten\n\n\n' },
      '2026-07-13T19:00:00Z'
    );
    const once = store.get(doc.meta.id)!;
    expect(once.body).toBe('\n## Description\n\nrewritten\n');
    const file = store.taskFilePath(doc.meta.id)!;
    const afterFirst = readFileSync(file, 'utf8');
    // Feeding the normalized body straight back must not drift it further.
    store.update(doc.meta.id, { body: once.body }, '2026-07-13T19:00:00Z');
    expect(readFileSync(file, 'utf8')).toBe(afterFirst);
  });

  it('applies a section patch on top of a whole-body replacement', () => {
    const store = TaskStore.init(root);
    const doc = store.create({ title: 'Ship docs' }, '2026-07-13T18:00:00Z');
    // Both fields target the body; the rewrite is the base the section edit
    // then lands on, so the result never depends on field order.
    store.update(doc.meta.id, {
      body: '## Description\n\nfrom body\n\n## Activity\n',
      description: 'from section',
    });
    const reread = store.get(doc.meta.id)!;
    expect(getSection(reread.body, 'Description')).toBe('from section');
  });

  it('round-trips markdown a body rewrite can legitimately contain', () => {
    const store = TaskStore.init(root);
    const doc = store.create({ title: 'Ship docs' }, '2026-07-13T18:00:00Z');
    // A thematic break is the interesting one: `---` is also the frontmatter
    // fence, so it would corrupt the file if the parser were greedy.
    const body =
      '## Description\n\nbefore\n\n---\n\nafter\n\n```yaml\nid: not-real\n```\n';
    store.update(doc.meta.id, { body });
    const reread = store.get(doc.meta.id)!;
    expect(reread.body).toBe(`\n${body.trim()}\n`);
    expect(reread.meta.id).toBe(doc.meta.id);
  });
});

describe('amend', () => {
  it('appends a dated, sourced amendment and bumps updated', () => {
    const store = TaskStore.init(root);
    const doc = store.create({ title: 'Sync issues' }, '2026-07-13T18:00:00Z');
    const out = store.amend(
      doc.meta.id,
      {
        overrides: 'join on the issue UUID, not the display key',
        reason: 'display keys are not stable across a rename',
        source: 'task-review',
      },
      '2026-07-13T19:00:00Z'
    );
    expect(out.meta.updated).toBe('2026-07-13T19:00:00Z');
    // Re-read from disk so the assertion covers what was persisted.
    const reread = store.get(doc.meta.id)!;
    expect(reread.body).toContain(
      'join on the issue UUID, not the display key'
    );
    expect(reread.body).toContain('task-review');
  });

  it('accumulates a second amendment rather than replacing the first', () => {
    const store = TaskStore.init(root);
    const doc = store.create({ title: 'Sync issues' }, '2026-07-13T18:00:00Z');
    store.amend(doc.meta.id, {
      overrides: 'first fix',
      reason: 'first reason',
      source: null,
    });
    store.amend(doc.meta.id, {
      overrides: 'second fix',
      reason: 'second reason',
      source: null,
    });
    const reread = store.get(doc.meta.id)!;
    expect(reread.body).toContain('first fix');
    expect(reread.body).toContain('second fix');
  });

  it('throws on an unknown task id', () => {
    const store = TaskStore.init(root);
    expect(() =>
      store.amend('t-nope00', { overrides: 'x', reason: 'y', source: null })
    ).toThrow(/task not found/);
  });
});
