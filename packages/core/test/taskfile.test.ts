import { describe, expect, it } from 'bun:test';

import {
  parseTaskFile,
  serializeTaskFile,
  setSection,
  TaskParseError,
} from '../src/taskfile.js';
import type { TaskDoc } from '../src/types.js';

describe('setSection', () => {
  const body =
    '\n## Description\n\nold\n\n## Acceptance Criteria\n\n## Activity\n- created\n';

  it('replaces a section body while preserving the others and their order', () => {
    const out = setSection(body, 'Description', 'brand new text');
    expect(out).toContain('## Description\n\nbrand new text\n\n');
    // Untouched sections and the activity log stay put, in the same order.
    expect(out).toContain('## Activity\n- created\n');
    expect(out.indexOf('## Description')).toBeLessThan(
      out.indexOf('## Acceptance Criteria')
    );
    expect(out.indexOf('## Acceptance Criteria')).toBeLessThan(
      out.indexOf('## Activity')
    );
  });

  it('fills an empty section', () => {
    const out = setSection(body, 'Acceptance Criteria', '- ships green');
    expect(out).toContain('## Acceptance Criteria\n\n- ships green\n\n');
  });

  it('collapses to blank lines when cleared', () => {
    const out = setSection(body, 'Description', '   ');
    expect(out).toContain('## Description\n\n## Acceptance Criteria');
  });

  it('inserts a missing section before Activity', () => {
    const out = setSection('\n## Activity\n- created\n', 'Description', 'hi');
    expect(out).toMatch(/## Description\n\nhi\n\n## Activity/);
  });

  it('round-trips through parse + serialize', () => {
    const edited = setSection(body, 'Description', 'edited');
    const doc: TaskDoc = {
      meta: parseTaskFile(FRONTMATTER + body).meta,
      body: edited,
    };
    const reparsed = parseTaskFile(serializeTaskFile(doc));
    expect(reparsed.body).toContain('edited');
  });
});

const FRONTMATTER =
  '---\nid: t-3fa9c2\ntitle: T\nstatus: todo\nkind: task\ncreated: 2026-07-13T00:00:00Z\nupdated: 2026-07-13T00:00:00Z\n---\n';

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
