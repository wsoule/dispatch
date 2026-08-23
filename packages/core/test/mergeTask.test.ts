import { describe, expect, it } from 'bun:test';

import { mergeTaskFile } from '../src/mergeTask.js';

const doc = (fields: Record<string, string>, activity: string[]) =>
  [
    '---',
    ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`),
    '---',
    '',
    '## Activity',
    '',
    ...activity.map((a) => `- ${a}`),
    '',
  ].join('\n');

const base = doc({ id: 't-abc123', status: 'ready', priority: 'none' }, [
  'created',
]);

describe('mergeTaskFile', () => {
  it('unions Activity lines added on both sides', () => {
    const ours = doc({ id: 't-abc123', status: 'ready', priority: 'none' }, [
      'created',
      'alice commented',
    ]);
    const theirs = doc({ id: 't-abc123', status: 'ready', priority: 'none' }, [
      'created',
      'bob commented',
    ]);
    const result = mergeTaskFile(base, ours, theirs);
    expect(result.ok).toBe(true);
    expect(result.merged).toContain('- alice commented');
    expect(result.merged).toContain('- bob commented');
  });

  it('takes both changes when different fields moved', () => {
    const ours = doc({ id: 't-abc123', status: 'working', priority: 'none' }, [
      'created',
    ]);
    const theirs = doc({ id: 't-abc123', status: 'ready', priority: 'high' }, [
      'created',
    ]);
    const result = mergeTaskFile(base, ours, theirs);
    expect(result.ok).toBe(true);
    expect(result.merged).toContain('status: working');
    expect(result.merged).toContain('priority: high');
  });

  it('conflicts when both sides set the same field differently', () => {
    const ours = doc({ id: 't-abc123', status: 'working', priority: 'none' }, [
      'created',
    ]);
    const theirs = doc({ id: 't-abc123', status: 'landed', priority: 'none' }, [
      'created',
    ]);
    const result = mergeTaskFile(base, ours, theirs);
    expect(result.ok).toBe(false);
    expect(result.merged).toContain('<<<<<<<');
  });

  it('does not duplicate an identical line added on both sides', () => {
    const same = doc({ id: 't-abc123', status: 'ready', priority: 'none' }, [
      'created',
      'same line',
    ]);
    const result = mergeTaskFile(base, same, same);
    expect(result.ok).toBe(true);
    expect(result.merged.match(/- same line/g)).toHaveLength(1);
  });

  it('keeps the newer updated timestamp without conflicting', () => {
    const b = doc({ id: 't-abc123', updated: '2026-08-01T00:00:00.000Z' }, []);
    const ours = doc(
      { id: 't-abc123', updated: '2026-08-02T00:00:00.000Z' },
      []
    );
    const theirs = doc(
      { id: 't-abc123', updated: '2026-08-03T00:00:00.000Z' },
      []
    );
    const result = mergeTaskFile(b, ours, theirs);
    expect(result.ok).toBe(true);
    expect(result.merged).toContain('updated: 2026-08-03T00:00:00.000Z');
  });

  it('does not conflict on a field that is null on every side', () => {
    // parent/milestone/external default to the literal YAML `null`, which
    // must not collide with the "no consensus" sentinel used internally.
    const b = doc({ id: 't-abc123', status: 'ready', parent: 'null' }, []);
    const ours = doc({ id: 't-abc123', status: 'working', parent: 'null' }, []);
    const theirs = doc({ id: 't-abc123', status: 'ready', parent: 'null' }, []);
    const result = mergeTaskFile(b, ours, theirs);
    expect(result.ok).toBe(true);
    expect(result.merged).not.toContain('<<<<<<<');
    expect(result.merged).toContain('parent: null');
    expect(result.merged).toContain('status: working');
  });
});
