import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ReviewComment } from '../src/reviewComments';
import {
  formatCommentsForAgent,
  resolveAnchor,
  ReviewCommentStore,
} from '../src/reviewComments';
import type { ReviewTarget } from '../src/reviewTarget.js';
import { reviewTargetSlug } from '../src/reviewTarget.js';

// ReviewCommentStore writes beside the run transcript under DISPATCH_HOME, not
// under the root it is handed — left unset that is the developer's real home.
let fakeHome: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

function root(): string {
  return mkdtempSync(join(tmpdir(), 'dispatch-review-'));
}

// Most tests below only care about run-keyed storage, not the pr case — this
// shortens every call site back down to what it looked like before targets.
function run(runId: string): ReviewTarget {
  return { kind: 'run', runId };
}

function comment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'rc-1',
    file: 'src/a.ts',
    line: 3,
    anchorText: '  const x = 1;',
    author: 'human:wyat',
    body: 'do not swallow this',
    resolved: false,
    pending: false,
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

describe('reviewTargetSlug', () => {
  test('a run target keeps its existing on-disk filename', () => {
    expect(reviewTargetSlug({ kind: 'run', runId: 'r-abc' })).toBe('r-abc');
  });

  test('a pr target gets its own slug that cannot collide with a run id', () => {
    expect(reviewTargetSlug({ kind: 'pr', number: 9 })).toBe('pr-9');
  });
});

describe('ReviewCommentStore', () => {
  test('a pr target stores and lists its own comments', () => {
    const store = new ReviewCommentStore(root(), '');
    const target = { kind: 'pr', number: 9 } as const;
    store.add(target, {
      file: 'src/a.ts',
      line: 3,
      anchorText: 'const x = 1;',
      body: 'why one?',
    });
    expect(store.list(target)).toHaveLength(1);
    expect(store.list({ kind: 'run', runId: 'r-abc' })).toHaveLength(0);
  });

  test('adds and reads back across instances', () => {
    const dir = root();
    new ReviewCommentStore(dir, '').add(run('r-1'), {
      file: 'src/a.ts',
      line: 3,
      anchorText: 'x',
      body: 'look at this',
    });
    const all = new ReviewCommentStore(dir, '').list(run('r-1'));
    expect(all).toHaveLength(1);
    expect(all[0]?.body).toBe('look at this');
    expect(all[0]?.resolved).toBe(false);
  });

  test('comments are scoped per run', () => {
    const dir = root();
    const store = new ReviewCommentStore(dir, '');
    store.add(run('r-1'), { file: 'a', line: 1, anchorText: 'x', body: 'one' });
    expect(store.list(run('r-2'))).toEqual([]);
  });

  test('replies append in order and stay on the thread', () => {
    const dir = root();
    const store = new ReviewCommentStore(dir, '');
    const c = store.add(run('r-1'), {
      file: 'a',
      line: 1,
      anchorText: 'x',
      body: 'first',
    });
    store.reply(run('r-1'), c.id, 'second');
    store.reply(run('r-1'), c.id, 'third');
    const replies = store.list(run('r-1'))[0]?.replies ?? [];
    expect(replies.map((r) => r.body)).toEqual(['second', 'third']);
  });

  test('resolve toggles both ways and persists', () => {
    const dir = root();
    const store = new ReviewCommentStore(dir, '');
    const c = store.add(run('r-1'), {
      file: 'a',
      line: 1,
      anchorText: 'x',
      body: 'b',
    });
    store.setResolved(run('r-1'), c.id, true);
    expect(store.list(run('r-1'))[0]?.resolved).toBe(true);
    store.setResolved(run('r-1'), c.id, false);
    expect(store.list(run('r-1'))[0]?.resolved).toBe(false);
  });

  test('replying to a missing comment throws rather than silently doing nothing', () => {
    expect(() =>
      new ReviewCommentStore(root(), '').reply(run('r-1'), 'rc-nope', 'x')
    ).toThrow(/not found/);
  });

  test('remove drops just that comment', () => {
    const dir = root();
    const store = new ReviewCommentStore(dir, '');
    const a = store.add(run('r-1'), {
      file: 'a',
      line: 1,
      anchorText: 'x',
      body: 'a',
    });
    store.add(run('r-1'), { file: 'a', line: 2, anchorText: 'y', body: 'b' });
    store.remove(run('r-1'), a.id);
    expect(store.list(run('r-1')).map((c) => c.body)).toEqual(['b']);
  });

  test('a run with no comments reads as empty, not an error', () => {
    expect(new ReviewCommentStore(root(), '').list(run('r-never'))).toEqual([]);
  });
});

// moveAll is how a run whose work moved onto a PR keeps the comments it
// already had: once that run's comments resolve to the PR target, anything
// left behind in the run's own file is invisible to every surface.
describe('ReviewCommentStore.moveAll', () => {
  const pr = { kind: 'pr', number: 9 } as const;

  test('moves a run’s comments onto the pr target and empties the run', () => {
    const store = new ReviewCommentStore(root(), '');
    store.add(run('r-1'), { file: 'a', line: 1, anchorText: 'x', body: 'one' });
    store.add(run('r-1'), { file: 'a', line: 2, anchorText: 'y', body: 'two' });
    store.moveAll(run('r-1'), pr);
    expect(store.list(pr).map((c) => c.body)).toEqual(['one', 'two']);
    expect(store.list(run('r-1'))).toEqual([]);
  });

  test('appends after what the pr target already had', () => {
    const store = new ReviewCommentStore(root(), '');
    store.add(pr, { file: 'a', line: 1, anchorText: 'x', body: 'from github' });
    store.add(run('r-1'), {
      file: 'a',
      line: 2,
      anchorText: 'y',
      body: 'mine',
    });
    store.moveAll(run('r-1'), pr);
    expect(store.list(pr).map((c) => c.body)).toEqual(['from github', 'mine']);
  });

  // Every run comment route calls this, so a second call must not duplicate
  // what the first one already moved.
  test('is a no-op the second time, and when there was nothing to move', () => {
    const store = new ReviewCommentStore(root(), '');
    store.add(run('r-1'), { file: 'a', line: 1, anchorText: 'x', body: 'one' });
    store.moveAll(run('r-1'), pr);
    store.moveAll(run('r-1'), pr);
    store.moveAll(run('r-2'), pr);
    expect(store.list(pr)).toHaveLength(1);
  });
});

describe('ReviewCommentStore attribution', () => {
  test('an added comment defaults to the store’s configured author', () => {
    const store = new ReviewCommentStore(root(), 'human:wyat');
    const c = store.add(run('r-1'), {
      file: 'a',
      line: 1,
      anchorText: 'x',
      body: 'b',
    });
    expect(c.author).toBe('human:wyat');
  });

  test('an explicit author overrides the store default', () => {
    const store = new ReviewCommentStore(root(), 'human:wyat');
    const c = store.add(run('r-1'), {
      file: 'a',
      line: 1,
      anchorText: 'x',
      body: 'b',
      author: 'agent:wyat/claude',
    });
    expect(c.author).toBe('agent:wyat/claude');
  });

  test('a reply defaults to the store’s configured author', () => {
    const store = new ReviewCommentStore(root(), 'human:wyat');
    const c = store.add(run('r-1'), {
      file: 'a',
      line: 1,
      anchorText: 'x',
      body: 'b',
    });
    const replied = store.reply(run('r-1'), c.id, 'reply text');
    expect(replied.replies[0]?.author).toBe('human:wyat');
  });
});

describe('formatCommentsForAgent', () => {
  test('includes file, line, the anchored code, the comment and its replies', () => {
    const out = formatCommentsForAgent([
      comment({
        replies: [
          { id: 'rr-1', author: 'human:wyat', body: 'and this', created: '' },
        ],
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

describe('pending review batching', () => {
  test('a new comment is pending by default', () => {
    const dir = root();
    const store = new ReviewCommentStore(dir, '');
    const c = store.add(run('r-1'), {
      file: 'a',
      line: 1,
      anchorText: 'x',
      body: 'b',
    });
    expect(c.pending).toBe(true);
  });

  test('pending can be opted out of, for a reply-style immediate note', () => {
    const store = new ReviewCommentStore(root(), '');
    const c = store.add(run('r-1'), {
      file: 'a',
      line: 1,
      anchorText: 'x',
      body: 'b',
      pending: false,
    });
    expect(c.pending).toBe(false);
  });

  // The whole point of staging: the agent hears about a review once, when it is submitted.
  test('a pending comment never reaches the agent', () => {
    const store = new ReviewCommentStore(root(), '');
    store.add(run('r-1'), {
      file: 'a',
      line: 1,
      anchorText: 'x',
      body: 'do not send me yet',
    });
    expect(formatCommentsForAgent(store.list(run('r-1')))).toBe('');
  });

  test('publishing releases them, and then they do reach the agent', () => {
    const dir = root();
    const store = new ReviewCommentStore(dir, '');
    store.add(run('r-1'), {
      file: 'a',
      line: 1,
      anchorText: 'x',
      body: 'now send',
    });
    expect(store.publishPending(run('r-1'))).toBe(1);
    expect(formatCommentsForAgent(store.list(run('r-1')))).toContain(
      'now send'
    );
  });

  test('publishing twice releases nothing the second time', () => {
    const store = new ReviewCommentStore(root(), '');
    store.add(run('r-1'), { file: 'a', line: 1, anchorText: 'x', body: 'b' });
    expect(store.publishPending(run('r-1'))).toBe(1);
    expect(store.publishPending(run('r-1'))).toBe(0);
  });

  test('pendingCount is what the review bar counts down', () => {
    const store = new ReviewCommentStore(root(), '');
    store.add(run('r-1'), { file: 'a', line: 1, anchorText: 'x', body: 'one' });
    store.add(run('r-1'), { file: 'a', line: 2, anchorText: 'y', body: 'two' });
    store.add(run('r-1'), {
      file: 'a',
      line: 3,
      anchorText: 'z',
      body: 'already sent',
      pending: false,
    });
    expect(store.pendingCount(run('r-1'))).toBe(2);
  });

  test('publishing one run does not touch another', () => {
    const dir = root();
    const store = new ReviewCommentStore(dir, '');
    store.add(run('r-1'), { file: 'a', line: 1, anchorText: 'x', body: 'b' });
    store.add(run('r-2'), { file: 'a', line: 1, anchorText: 'x', body: 'b' });
    store.publishPending(run('r-1'));
    expect(store.pendingCount(run('r-2'))).toBe(1);
  });
});

describe('range comments', () => {
  test('a range is stored and round-trips', () => {
    const dir = root();
    const store = new ReviewCommentStore(dir, '');
    store.add(run('r-1'), {
      file: 'a',
      line: 12,
      startLine: 8,
      anchorText: 'x',
      body: 'this whole block',
    });
    expect(new ReviewCommentStore(dir, '').list(run('r-1'))[0]).toMatchObject({
      line: 12,
      startLine: 8,
    });
  });

  test('a range renders as a span in the agent handoff', () => {
    const out = formatCommentsForAgent([
      comment({ startLine: 8, line: 12, pending: false }),
    ]);
    expect(out).toContain('Lines 8-12');
  });

  test('a single-line comment does not pretend to be a range', () => {
    const out = formatCommentsForAgent([
      comment({ startLine: 3, line: 3, pending: false }),
    ]);
    expect(out).toContain('Line 3:');
    expect(out).not.toContain('Lines 3-3');
  });
});
