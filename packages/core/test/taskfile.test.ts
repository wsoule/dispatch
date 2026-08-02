import { describe, expect, it } from 'bun:test';

import {
  appendAmendment,
  getSection,
  parseTaskFile,
  removeSection,
  serializeTaskFile,
  setSection,
  TaskParseError,
} from '../src/taskfile.js';
import type { Amendment } from '../src/taskfile.js';
import type { TaskDoc } from '../src/types.js';

describe('getSection', () => {
  const body =
    '\n## Description\n\nold\n\n## Acceptance Criteria\n\n## Activity\n- created\n';

  it('reads a section without its blank-line padding', () => {
    expect(getSection(body, 'Description')).toBe('old');
  });

  it('returns empty for a section with nothing under it', () => {
    expect(getSection(body, 'Acceptance Criteria')).toBe('');
  });

  it('returns empty for a heading that is not there', () => {
    expect(getSection(body, 'Notes')).toBe('');
  });

  it('keeps multi-line content, blank lines and all', () => {
    const out = getSection(
      setSection(body, 'Description', 'a\n\nb'),
      'Description'
    );
    expect(out).toBe('a\n\nb');
  });

  it('round-trips whatever setSection wrote', () => {
    const written = setSection(body, 'Acceptance Criteria', '- ships green');
    expect(getSection(written, 'Acceptance Criteria')).toBe('- ships green');
  });
});

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

  it('round-trips content containing a line that looks like a section heading', () => {
    const injected = 'do X\n\n## Activity\n\n- fake activity entry injected';
    const out = setSection(body, 'Description', injected);
    // The real Activity heading is still the only one, and still last.
    expect(out.match(/^## Activity/gm)).toHaveLength(1);
    expect(getSection(out, 'Description')).toBe(injected);
    expect(getSection(out, 'Activity')).toBe('- created');
  });

  it('does not mistake content already containing a backslash-hash line for its own escaping', () => {
    const out = setSection(body, 'Description', '\\## looks pre-escaped');
    expect(getSection(out, 'Description')).toBe('\\## looks pre-escaped');
  });
});

describe('removeSection', () => {
  const body =
    '\n## Description\n\nold\n\n## Amendments\n\ncorrected\n\n## Activity\n- created\n';

  it('drops the heading entirely, unlike setSection clearing it', () => {
    const out = removeSection(body, 'Amendments');
    expect(out).not.toContain('Amendments');
    expect(out).toContain('## Description');
    expect(out).toContain('## Activity');
  });

  it('is a no-op when the heading is not present', () => {
    expect(removeSection(body, 'Notes')).toBe(body);
  });
});

describe('appendAmendment', () => {
  const body =
    '\n## Description\n\noriginal plan\n\n## Acceptance Criteria\n\n## Activity\n';
  const first: Amendment = {
    date: '2026-08-02T00:00:00Z',
    reason: 'ENG-123 style keys are not stable across a rename',
    overrides: 'join on the issue UUID, not the display key',
    source: 'task-review',
  };

  it('round-trips through the task file, source included', () => {
    const withAmendment = appendAmendment(body, first);
    const doc: TaskDoc = {
      meta: parseTaskFile(FRONTMATTER + body).meta,
      body: withAmendment,
    };
    const reparsed = parseTaskFile(serializeTaskFile(doc));
    expect(getSection(reparsed.body, 'Amendments')).toContain(
      'join on the issue UUID, not the display key'
    );
    expect(getSection(reparsed.body, 'Amendments')).toContain('task-review');
  });

  it('omits the Source line when none is given', () => {
    const out = appendAmendment(body, { ...first, source: null });
    expect(getSection(out, 'Amendments')).not.toContain('**Source:**');
  });

  it('accumulates a second amendment rather than replacing the first', () => {
    const once = appendAmendment(body, first);
    const twice = appendAmendment(once, {
      ...first,
      date: '2026-08-03T00:00:00Z',
      overrides: 'also index by team id',
    });
    const section = getSection(twice, 'Amendments');
    expect(section).toContain('join on the issue UUID, not the display key');
    expect(section).toContain('also index by team id');
  });

  it('leaves an existing task file without amendments parsing unchanged', () => {
    const doc: TaskDoc = {
      meta: parseTaskFile(FRONTMATTER + body).meta,
      body,
    };
    const text = serializeTaskFile(doc);
    expect(parseTaskFile(text)).toEqual(doc);
    expect(getSection(doc.body, 'Amendments')).toBe('');
  });

  it('keeps overrides and reason intact when overrides itself contains a heading-like line', () => {
    const injecting: Amendment = {
      ...first,
      overrides: 'do X\n\n## Activity\n\n- fake activity entry injected',
    };
    const out = appendAmendment(body, injecting);
    // Only the genuine Activity heading exists — nothing got split off into a
    // second one, and the Reason line survives attached to its Amendment.
    expect(out.match(/^## Activity/gm)).toHaveLength(1);
    const amendments = getSection(out, 'Amendments');
    expect(amendments).toContain(
      'do X\n\n## Activity\n\n- fake activity entry injected'
    );
    expect(amendments).toContain(first.reason);
    expect(getSection(out, 'Activity')).toBe('');
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
    milestone: null,
    blockedBy: ['t-91c4aa'],
    labels: ['bug', 'auth'],
    priority: 'high',
    assignee: 'agent',
    created: '2026-07-13T18:04:00Z',
    updated: '2026-07-13T18:04:00Z',
    external: null,
    selfReview: false,
    writes: [],
    risk: 'routine',
    model: null,
    exercised: false,
  },
  body: '\n## Description\n\nStuff.\n\n## Acceptance Criteria\n\n## Activity\n',
};

// The same task left at the self-review default (on), which is the case that writes no
// `self-review` key at all — `doc` above is the explicit opt-out.
const selfReviewing: TaskDoc = {
  ...doc,
  meta: { ...doc.meta, selfReview: true },
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
    expect(parsed.meta.selfReview).toBe(true);
    expect(parsed.meta.writes).toEqual([]);
    expect(parsed.meta.risk).toBe('routine');
    expect(parsed.meta.model).toBeNull();
    expect(parsed.meta.exercised).toBe(false);
    expect(parsed.body).toBe('body');
  });
  it('throws TaskParseError on missing frontmatter or required field', () => {
    expect(() => parseTaskFile('no frontmatter')).toThrow(TaskParseError);
    expect(() => parseTaskFile('---\ntitle: X\n---\n')).toThrow(
      /missing frontmatter field: id/
    );
  });
});

describe('selfReview / self-review frontmatter', () => {
  it('treats an absent self-review key as on', () => {
    expect(
      parseTaskFile(serializeTaskFile(selfReviewing)).meta.selfReview
    ).toBe(true);
  });

  it('parses self-review: false', () => {
    const text = serializeTaskFile(doc);
    expect(text).toContain('self-review: false');
    expect(parseTaskFile(text).meta.selfReview).toBe(false);
  });

  it('omits the self-review key entirely when on, to keep files clean', () => {
    expect(serializeTaskFile(selfReviewing)).not.toContain('self-review');
  });

  it('round-trips the opt-out through serialize + parse', () => {
    const text = serializeTaskFile(doc);
    expect(parseTaskFile(text)).toEqual(doc);
    expect(serializeTaskFile(parseTaskFile(text))).toBe(text);
  });

  it('round-trips archived-at and omits the key when unset', () => {
    expect(
      parseTaskFile(serializeTaskFile(doc)).meta.archivedAt
    ).toBeUndefined();
    expect(serializeTaskFile(doc)).not.toContain('archived-at');
    const archived: TaskDoc = {
      ...doc,
      meta: { ...doc.meta, archivedAt: '2026-07-26T00:00:00Z' },
    };
    const back = parseTaskFile(serializeTaskFile(archived));
    expect(back.meta.archivedAt).toBe('2026-07-26T00:00:00Z');
  });

  it('round-trips exercised and omits the key when false', () => {
    expect(serializeTaskFile(doc)).not.toContain('exercised');
    const exercised: TaskDoc = {
      ...doc,
      meta: { ...doc.meta, exercised: true },
    };
    const text = serializeTaskFile(exercised);
    expect(text).toContain('exercised: true');
    expect(parseTaskFile(text).meta.exercised).toBe(true);
  });

  it('throws on non-boolean self-review', () => {
    const text = [
      '---',
      'id: t-aaaaaa',
      'title: Minimal',
      'status: todo',
      'kind: task',
      'created: 2026-07-13T00:00:00Z',
      'updated: 2026-07-13T00:00:00Z',
      'self-review: yes-please',
      '---',
      'body',
    ].join('\n');
    expect(() => parseTaskFile(text)).toThrow(TaskParseError);
    expect(() => parseTaskFile(text)).toThrow(
      /invalid self-review: expected a boolean/
    );
  });

  it('throws on non-string archived-at', () => {
    const text = [
      '---',
      'id: t-aaaaaa',
      'title: Minimal',
      'status: todo',
      'kind: task',
      'created: 2026-07-13T00:00:00Z',
      'updated: 2026-07-13T00:00:00Z',
      'archived-at: 42',
      '---',
      'body',
    ].join('\n');
    expect(() => parseTaskFile(text)).toThrow(TaskParseError);
    expect(() => parseTaskFile(text)).toThrow(
      /invalid archived-at: expected a string/
    );
  });
});

describe('writes / risk / model frontmatter', () => {
  it('round-trips a non-default writes, risk and model', () => {
    const withOverrides: TaskDoc = {
      ...doc,
      meta: {
        ...doc.meta,
        writes: ['src/**', 'packages/core/src/types.ts'],
        risk: 'critical',
        model: 'claude-opus-4',
      },
    };
    const text = serializeTaskFile(withOverrides);
    expect(parseTaskFile(text)).toEqual(withOverrides);
    expect(serializeTaskFile(parseTaskFile(text))).toBe(text);
  });

  it('always serializes writes, even when empty', () => {
    expect(serializeTaskFile(doc)).toContain('writes: []');
  });

  it('omits risk when routine and model when null', () => {
    const text = serializeTaskFile(doc);
    expect(text).not.toContain('risk:');
    expect(text).not.toContain('model:');
  });

  it('serializes risk when not routine', () => {
    const elevated: TaskDoc = {
      ...doc,
      meta: { ...doc.meta, risk: 'elevated' },
    };
    expect(serializeTaskFile(elevated)).toContain('risk: elevated');
  });

  it('serializes model when set', () => {
    const withModel: TaskDoc = {
      ...doc,
      meta: { ...doc.meta, model: 'claude-haiku-4' },
    };
    expect(serializeTaskFile(withModel)).toContain('model: claude-haiku-4');
  });

  it('throws TaskParseError on an invalid risk', () => {
    const text = [
      '---',
      'id: t-aaaaaa',
      'title: Minimal',
      'status: todo',
      'kind: task',
      'created: 2026-07-13T00:00:00Z',
      'updated: 2026-07-13T00:00:00Z',
      'risk: urgent',
      '---',
      'body',
    ].join('\n');
    expect(() => parseTaskFile(text)).toThrow(TaskParseError);
    expect(() => parseTaskFile(text)).toThrow(/invalid risk: urgent/);
  });

  it('throws TaskParseError on a non-string model', () => {
    const text = [
      '---',
      'id: t-aaaaaa',
      'title: Minimal',
      'status: todo',
      'kind: task',
      'created: 2026-07-13T00:00:00Z',
      'updated: 2026-07-13T00:00:00Z',
      'model: 42',
      '---',
      'body',
    ].join('\n');
    expect(() => parseTaskFile(text)).toThrow(TaskParseError);
    expect(() => parseTaskFile(text)).toThrow(
      /invalid model: expected a string/
    );
  });

  it('throws TaskParseError on non-array writes', () => {
    const text = [
      '---',
      'id: t-aaaaaa',
      'title: Minimal',
      'status: todo',
      'kind: task',
      'created: 2026-07-13T00:00:00Z',
      'updated: 2026-07-13T00:00:00Z',
      'writes: src/index.ts',
      '---',
      'body',
    ].join('\n');
    expect(() => parseTaskFile(text)).toThrow(TaskParseError);
    expect(() => parseTaskFile(text)).toThrow(
      /invalid writes: expected a list of strings/
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
