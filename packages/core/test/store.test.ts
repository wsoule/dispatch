import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/store.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dispatch-')); });

describe('TaskStore.init', () => {
  it('creates .dispatch/tasks and config.yml, idempotently', () => {
    TaskStore.init(root);
    TaskStore.init(root);
    expect(existsSync(join(root, '.dispatch/tasks'))).toBe(true);
    expect(readFileSync(join(root, '.dispatch/config.yml'), 'utf8')).toContain('autoCommit: false');
  });
});

describe('create/get', () => {
  it('writes <id>-<slug>.md with template body and returns the doc', () => {
    const store = TaskStore.init(root);
    const doc = store.create(
      { title: 'Fix login', description: 'It loops.', priority: 'high' },
      '2026-07-13T18:00:00Z',
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
    expect(store.create({ title: 'Auth', kind: 'epic' }).meta.id).toMatch(/^e-/);
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
    const epic = store.create({ title: 'Epic', kind: 'epic' }, '2026-07-13T01:00:00Z');
    store.create({ title: 'A', parent: epic.meta.id }, '2026-07-13T02:00:00Z');
    const b = store.create({ title: 'B', status: 'backlog' }, '2026-07-13T03:00:00Z');
    expect(store.list().map(t => t.meta.title)).toEqual(['Epic', 'A', 'B']);
    expect(store.list({ status: 'backlog' })[0].meta.id).toBe(b.meta.id);
    expect(store.list({ kind: 'epic' })).toHaveLength(1);
    expect(store.list({ parent: epic.meta.id })[0].meta.title).toBe('A');
  });
});

describe('update', () => {
  it('patches fields, bumps updated, appends activity, keeps filename', () => {
    const store = TaskStore.init(root);
    const doc = store.create({ title: 'Fix login' }, '2026-07-13T18:00:00Z');
    const out = store.update(
      doc.meta.id,
      { status: 'in-progress', title: 'Renamed', appendActivity: 'started' },
      '2026-07-13T19:00:00Z',
    );
    expect(out.meta.status).toBe('in-progress');
    expect(out.meta.updated).toBe('2026-07-13T19:00:00Z');
    expect(out.body).toContain('- started');
    expect(store.taskFilePath(doc.meta.id)).toContain('fix-login.md');
    expect(() => store.update('t-nope00', { status: 'done' })).toThrow(/task not found/);
  });
});
