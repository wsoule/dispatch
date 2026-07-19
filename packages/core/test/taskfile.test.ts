import { describe, expect, it } from 'bun:test';

import {
  parseTaskFile,
  serializeTaskFile,
  TaskParseError,
} from '../src/taskfile.js';
import type { TaskDoc } from '../src/types.js';

const doc: TaskDoc = {
  meta: {
    id: 't-3fa9c2',
    title: 'Fix login redirect loop',
    status: 'todo',
    kind: 'task',
    parent: 'e-8b21d0',
    blockedBy: ['t-91c4aa'],
    labels: ['bug', 'auth'],
    priority: 'high',
    assignee: 'agent',
    created: '2026-07-13T18:04:00Z',
    updated: '2026-07-13T18:04:00Z',
    external: null,
  },
  body: '\n## Description\n\nStuff.\n\n## Acceptance Criteria\n\n## Activity\n',
};

describe('serializeTaskFile / parseTaskFile', () => {
  it('round-trips exactly', () => {
    const text = serializeTaskFile(doc);
    expect(parseTaskFile(text)).toEqual(doc);
    expect(serializeTaskFile(parseTaskFile(text))).toBe(text);
  });
  it('writes kebab-case blocked-by in frontmatter', () => {
    expect(serializeTaskFile(doc)).toContain('blocked-by:');
  });
  it('applies defaults for optional fields', () => {
    const text = [
      '---',
      'id: t-aaaaaa',
      'title: Minimal',
      'status: todo',
      'kind: task',
      'created: 2026-07-13T00:00:00Z',
      'updated: 2026-07-13T00:00:00Z',
      '---',
      'body',
    ].join('\n');
    const parsed = parseTaskFile(text);
    expect(parsed.meta.blockedBy).toEqual([]);
    expect(parsed.meta.labels).toEqual([]);
    expect(parsed.meta.parent).toBeNull();
    expect(parsed.meta.priority).toBe('none');
    expect(parsed.meta.assignee).toBe('none');
    expect(parsed.meta.external).toBeNull();
    expect(parsed.body).toBe('body');
  });
  it('throws TaskParseError on missing frontmatter or required field', () => {
    expect(() => parseTaskFile('no frontmatter')).toThrow(TaskParseError);
    expect(() => parseTaskFile('---\ntitle: X\n---\n')).toThrow(
      /missing frontmatter field: id/
    );
  });
});

describe('parseTaskFile frontmatter shape validation', () => {
  const base = (overrides: string[]) =>
    [
      '---',
      'id: t-aaaaaa',
      'title: Minimal',
      'status: todo',
      'kind: task',
      'created: 2026-07-13T00:00:00Z',
      'updated: 2026-07-13T00:00:00Z',
      ...overrides,
      '---',
      'body',
    ].join('\n');

  it('throws on invalid kind', () => {
    const text = base([]).replace('kind: task', 'kind: nonsense');
    expect(() => parseTaskFile(text)).toThrow(TaskParseError);
    expect(() => parseTaskFile(text)).toThrow(/invalid kind: nonsense/);
  });
  it('throws on bare-scalar blocked-by', () => {
    const text = base(['blocked-by: t-1']);
    expect(() => parseTaskFile(text)).toThrow(TaskParseError);
    expect(() => parseTaskFile(text)).toThrow(
      /invalid blocked-by: expected a list of strings/
    );
  });
  it('throws on non-array labels', () => {
    const text = base(['labels: bug']);
    expect(() => parseTaskFile(text)).toThrow(TaskParseError);
    expect(() => parseTaskFile(text)).toThrow(
      /invalid labels: expected a list of strings/
    );
  });
  it('parses unknown status fine (tolerant for custom config statuses)', () => {
    const text = base([]).replace('status: todo', 'status: someday');
    expect(parseTaskFile(text).meta.status).toBe('someday');
  });
});
