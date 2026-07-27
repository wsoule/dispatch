import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ReviewComment } from '../src/reviewComments';
import {
  formatCommentsForAgent,
  resolveAnchor,
  ReviewCommentStore,
} from '../src/reviewComments';

function root(): string {
  return mkdtempSync(join(tmpdir(), 'dispatch-review-'));
}

function comment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'rc-1',
    file: 'src/a.ts',
    line: 3,
    anchorText: '  const x = 1;',
    author: 'You',
    body: 'do not swallow this',
    resolved: false,
    created: '2026-07-27T00:00:00.000Z',
    replies: [],
    ...over,
  };
}

const FILE = ['line one', 'line two', '  const x = 1;', 'line four'];

describe('resolveAnchor', () => {
  test('exact when the line still says what it said', () => {
    expect(resolveAnchor(comment(), FILE)).toEqual({ kind: 'exact', line: 3 });
  });

  // A shifted line is followable only because the text is unique — that is what makes it a
  // fact rather than a guess.
  test('moved when the text is now somewhere else, uniquely', () => {
    const shifted = ['added', ...FILE];
    expect(resolveAnchor(comment(), shifted)).toEqual({
      kind: 'moved',
      line: 4,
    });
  });

  test('outdated when the code it was about is gone', () => {
    expect(resolveAnchor(comment(), ['nothing', 'like', 'it'])).toEqual({
      kind: 'outdated',
    });
  });

  // Two candidates means we cannot know which was meant. Picking one would present a guess as
  // a fact, which is worse than admitting the comment has drifted.
  test('outdated when the anchor text is now ambiguous', () => {
    const dupes = ['  const x = 1;', 'x', '  const x = 1;'];
    expect(resolveAnchor(comment({ line: 1 }), dupes)).toEqual({
      kind: 'exact',
      line: 1,
    });
    expect(resolveAnchor(comment({ line: 2 }), dupes)).toEqual({
      kind: 'outdated',
    });
  });

  // A blank anchor matches half of every file, so it can never be followed safely.
  test('a whitespace-only anchor is never followed', () => {
    expect(
      resolveAnchor(comment({ anchorText: '   ', line: 99 }), FILE)
    ).toEqual({ kind: 'outdated' });
  });

  // An out-of-range line is not itself a reason to give up: if the file shrank but the exact
  // code is still there once, the comment genuinely moved and following it is correct.
  test('an out-of-range line still follows a unique anchor', () => {
    expect(resolveAnchor(comment({ line: 999 }), FILE)).toEqual({
      kind: 'moved',
      line: 3,
    });
  });

  test('an out-of-range line with no surviving anchor is outdated, not a crash', () => {
    expect(
      resolveAnchor(comment({ line: 999 }), ['nothing', 'like', 'it'])
    ).toEqual({ kind: 'outdated' });
  });

  test('whitespace changes on the line count as drift', () => {
    expect(resolveAnchor(comment(), ['a', 'b', 'const x = 1;', 'd'])).toEqual({
      kind: 'outdated',
    });
  });
});

describe('ReviewCommentStore', () => {
  test('adds and reads back across instances', () => {
    const dir = root();
    new ReviewCommentStore(dir).add('r-1', {
      file: 'src/a.ts',
      line: 3,
      anchorText: 'x',
      body: 'look at this',
    });
    const all = new ReviewCommentStore(dir).list('r-1');
    expect(all).toHaveLength(1);
    expect(all[0]?.body).toBe('look at this');
    expect(all[0]?.resolved).toBe(false);
  });

  test('comments are scoped per run', () => {
    const dir = root();
    const store = new ReviewCommentStore(dir);
    store.add('r-1', { file: 'a', line: 1, anchorText: 'x', body: 'one' });
    expect(store.list('r-2')).toEqual([]);
  });

  test('replies append in order and stay on the thread', () => {
    const dir = root();
    const store = new ReviewCommentStore(dir);
    const c = store.add('r-1', {
      file: 'a',
      line: 1,
      anchorText: 'x',
      body: 'first',
    });
    store.reply('r-1', c.id, 'second');
    store.reply('r-1', c.id, 'third');
    const replies = store.list('r-1')[0]?.replies ?? [];
    expect(replies.map((r) => r.body)).toEqual(['second', 'third']);
  });

  test('resolve toggles both ways and persists', () => {
    const dir = root();
    const store = new ReviewCommentStore(dir);
    const c = store.add('r-1', {
      file: 'a',
      line: 1,
      anchorText: 'x',
      body: 'b',
    });
    store.setResolved('r-1', c.id, true);
    expect(store.list('r-1')[0]?.resolved).toBe(true);
    store.setResolved('r-1', c.id, false);
    expect(store.list('r-1')[0]?.resolved).toBe(false);
  });

  test('replying to a missing comment throws rather than silently doing nothing', () => {
    expect(() =>
      new ReviewCommentStore(root()).reply('r-1', 'rc-nope', 'x')
    ).toThrow(/not found/);
  });

  test('remove drops just that comment', () => {
    const dir = root();
    const store = new ReviewCommentStore(dir);
    const a = store.add('r-1', {
      file: 'a',
      line: 1,
      anchorText: 'x',
      body: 'a',
    });
    store.add('r-1', { file: 'a', line: 2, anchorText: 'y', body: 'b' });
    store.remove('r-1', a.id);
    expect(store.list('r-1').map((c) => c.body)).toEqual(['b']);
  });

  test('a run with no comments reads as empty, not an error', () => {
    expect(new ReviewCommentStore(root()).list('r-never')).toEqual([]);
  });
});

describe('formatCommentsForAgent', () => {
  test('includes file, line, the anchored code, the comment and its replies', () => {
    const out = formatCommentsForAgent([
      comment({
        replies: [{ id: 'rr-1', author: 'You', body: 'and this', created: '' }],
      }),
    ]);
    expect(out).toContain('src/a.ts');
    expect(out).toContain('Line 3');
    expect(out).toContain('const x = 1;');
    expect(out).toContain('do not swallow this');
    expect(out).toContain('and this');
  });

  // Resolving a thread is exactly how you say "never mind" — sending it anyway would have the
  // agent redo work you already decided against.
  test('resolved threads are left out', () => {
    expect(formatCommentsForAgent([comment({ resolved: true })])).toBe('');
  });

  test('nothing open produces an empty string, not an empty header', () => {
    expect(formatCommentsForAgent([])).toBe('');
  });

  test('groups by file and orders by line within each', () => {
    const out = formatCommentsForAgent([
      comment({ id: 'rc-2', file: 'src/b.ts', line: 9, body: 'later' }),
      comment({ id: 'rc-1', file: 'src/b.ts', line: 2, body: 'earlier' }),
    ]);
    expect(out.indexOf('earlier')).toBeLessThan(out.indexOf('later'));
    expect(out.split('### src/b.ts')).toHaveLength(2);
  });

  test('an empty anchor omits the code block rather than printing an empty one', () => {
    const out = formatCommentsForAgent([comment({ anchorText: '' })]);
    expect(out).not.toContain('```');
    expect(out).toContain('do not swallow this');
  });
});
