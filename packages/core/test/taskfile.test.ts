import { describe, it, expect } from 'vitest';
import { parseTaskFile, serializeTaskFile, TaskParseError } from '../src/taskfile.js';
import type { TaskDoc } from '../src/types.js';

const doc: TaskDoc = {
  meta: {
    id: 't-3fa9c2', title: 'Fix login redirect loop', status: 'todo', kind: 'task',
    parent: 'e-8b21d0', blockedBy: ['t-91c4aa'], labels: ['bug', 'auth'],
    priority: 'high', assignee: 'agent',
    created: '2026-07-13T18:04:00Z', updated: '2026-07-13T18:04:00Z', external: null,
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
      'id: t-aaaaaa', 'title: Minimal', 'status: todo', 'kind: task',
      'created: 2026-07-13T00:00:00Z', 'updated: 2026-07-13T00:00:00Z',
      '---', 'body',
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
    expect(() => parseTaskFile('---\ntitle: X\n---\n')).toThrow(/missing frontmatter field: id/);
  });
});
