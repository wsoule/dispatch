import type { Finding, ReviewComment } from '@dispatch/client';
import type { FileDiffMetadata } from '@pierre/diffs';
import { describe, expect, test } from 'bun:test';

import type { BuildItemsInput } from './reviewDiffItems';
import { buildItems, reviewCacheKeyPrefix } from './reviewDiffItems';

// Pierre's `CodeView` keeps the record it already holds for an item until the item's `version`
// changes (`syncItemRecord` in @pierre/diffs 1.3.1). These tests pin the contract `buildItems`
// keeps with it: the version moves whenever something the item draws moves, stays put when
// nothing did, and freezes while the file is open in the editor.

// A type-complete `FileDiffMetadata` whose fields `buildItems` never reads stay empty.
function fileDiff(name: string): FileDiffMetadata {
  return {
    name,
    type: 'change',
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    deletionLines: [],
    additionLines: [],
  };
}

function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'c1',
    file: 'a.ts',
    line: 2,
    pending: false,
    anchorText: 'const b = 2;',
    author: 'human:noreply',
    body: 'Why two?',
    resolved: false,
    created: '2026-11-02T10:00:00.000Z',
    replies: [],
    ...overrides,
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f-000001',
    taskId: 't1',
    runId: 'r1',
    severity: 'minor',
    verdict: 'open',
    title: 'Off by one',
    detail: 'The loop stops a line early.',
    file: 'a.ts',
    line: 2,
    ruling: null,
    round: 0,
    createdAt: '2026-11-02T10:00:00.000Z',
    updatedAt: '2026-11-02T10:00:00.000Z',
    raisedBy: '',
    ...overrides,
  };
}

const A = fileDiff('a.ts');
const B = fileDiff('b.ts');

// The version `buildItems` gives `file` for this state; the other inputs default to "nothing
// layered on top", the way a freshly opened review renders.
function versionOf(
  input: Partial<BuildItemsInput>,
  file = 'a.ts'
): number | undefined {
  const items = buildItems({
    files: [A, B],
    editing: null,
    loaded: new Set(),
    ...input,
  });
  return items.find((item) => item.id === file)?.version;
}

describe('buildItems — the version follows what the item draws', () => {
  test('is a safe integer', () => {
    const version = versionOf({ comments: [comment()] });
    expect(Number.isSafeInteger(version)).toBe(true);
  });

  test('stays put when a rebuild changes nothing (a refetch with the same comments)', () => {
    // Fresh arrays and fresh comment objects with equal contents: what a poll returns.
    expect(versionOf({ comments: [comment()] })).toBe(
      versionOf({ comments: [comment()] })
    );
    expect(versionOf({})).toBe(versionOf({ comments: [], findings: [] }));
  });

  test('changes when a comment lands on the file', () => {
    expect(versionOf({ comments: [comment()] })).not.toBe(versionOf({}));
  });

  test('leaves the other files alone when a comment lands on one', () => {
    expect(versionOf({ comments: [comment()] }, 'b.ts')).toBe(
      versionOf({}, 'b.ts')
    );
  });

  test('changes when a thread gains a reply or is resolved', () => {
    const before = versionOf({ comments: [comment()] });
    const replied = versionOf({
      comments: [
        comment({
          replies: [
            {
              id: 'r1',
              author: 'agent',
              body: 'Two is the spec.',
              created: '2026-11-02T10:05:00.000Z',
            },
          ],
        }),
      ],
    });
    const resolved = versionOf({ comments: [comment({ resolved: true })] });
    expect(replied).not.toBe(before);
    expect(resolved).not.toBe(before);
    expect(resolved).not.toBe(replied);
  });

  test('changes when a finding lands on the file', () => {
    expect(versionOf({ findings: [finding()] })).not.toBe(versionOf({}));
  });

  test('changes when the composer opens, moves to another line and closes', () => {
    const closed = versionOf({});
    const open = versionOf({ composing: { file: 'a.ts', line: 2 } });
    const moved = versionOf({ composing: { file: 'a.ts', line: 1 } });
    const ranged = versionOf({
      composing: { file: 'a.ts', line: 2, startLine: 1 },
    });
    expect(open).not.toBe(closed);
    expect(moved).not.toBe(open);
    expect(ranged).not.toBe(open);
    // Closing it returns to the closed state's number, which differs from the open one Pierre
    // last saw, so the composer leaves the screen.
    expect(versionOf({ composing: null })).toBe(closed);
  });

  test('leaves the other files alone when the composer opens on one', () => {
    expect(versionOf({ composing: { file: 'a.ts', line: 2 } }, 'b.ts')).toBe(
      versionOf({}, 'b.ts')
    );
  });

  test('changes when the file is ticked viewed, and again when it is unticked', () => {
    const open = versionOf({});
    const ticked = versionOf({ viewed: new Set(['a.ts']) });
    const unticked = versionOf({ viewed: new Set() });
    expect(ticked).not.toBe(open);
    expect(unticked).toBe(open);
  });

  test('changes when a new patch is parsed, even with the same name and contents', () => {
    // A new parse is a new object: Pierre must take its `fileDiff`, or it keeps drawing the
    // previous patch's lines.
    const first = buildItems({ files: [A], editing: null, loaded: new Set() });
    const reparsed = buildItems({
      files: [fileDiff('a.ts')],
      editing: null,
      loaded: new Set(),
    });
    expect(reparsed[0]?.version).not.toBe(first[0]?.version);
  });

  test('keeps the number when Pierre fills in the same parse in place', () => {
    // `loadDiffFiles` hydrates a partial diff by mutating it; that is not a new diff.
    const hydrating = fileDiff('a.ts');
    const before = buildItems({
      files: [hydrating],
      editing: null,
      loaded: new Set(),
    });
    hydrating.isPartial = false;
    hydrating.additionLines = ['const a = 0;', 'const b = 2;'];
    const after = buildItems({
      files: [hydrating],
      editing: null,
      loaded: new Set(),
    });
    expect(after[0]?.version).toBe(before[0]?.version);
  });
});

describe('buildItems — the version is frozen while the file is being edited', () => {
  const editingA = { editing: 'a.ts', loaded: new Set(['a.ts']) };

  test('changes when edit mode turns on', () => {
    expect(versionOf(editingA)).not.toBe(
      versionOf({ loaded: editingA.loaded })
    );
  });

  test('changes when edit mode turns on for a viewed (collapsed) file', () => {
    const viewed = new Set(['a.ts']);
    expect(versionOf({ ...editingA, viewed })).not.toBe(
      versionOf({ loaded: editingA.loaded, viewed })
    );
  });

  test('does not move while the editor is open, whatever else arrives', () => {
    const editing = versionOf(editingA);
    expect(versionOf({ ...editingA, comments: [comment()] })).toBe(editing);
    expect(versionOf({ ...editingA, findings: [finding()] })).toBe(editing);
    expect(versionOf({ ...editingA, viewed: new Set(['a.ts']) })).toBe(editing);
    const reparsed = buildItems({
      files: [fileDiff('a.ts')],
      ...editingA,
      comments: [comment()],
    });
    expect(reparsed[0]?.version).toBe(editing);
  });

  test('changes when edit mode turns off, to the version of the state reached meanwhile', () => {
    const editing = versionOf(editingA);
    const before = versionOf({ loaded: editingA.loaded });
    const after = versionOf({ loaded: editingA.loaded, comments: [comment()] });
    expect(after).not.toBe(editing);
    expect(after).not.toBe(before);
    expect(after).toBe(versionOf({ comments: [comment()] }));
  });

  test('does not freeze the other files', () => {
    expect(
      versionOf({ ...editingA, comments: [comment({ file: 'b.ts' })] }, 'b.ts')
    ).not.toBe(versionOf(editingA, 'b.ts'));
  });

  test('does not freeze a file still behind the load gate', () => {
    // `editing` names it, but its contents have not arrived, so it is not in edit mode yet.
    const pending = { editing: 'a.ts', loaded: new Set<string>() };
    expect(versionOf({ ...pending, comments: [comment()] })).not.toBe(
      versionOf(pending)
    );
  });
});

describe('reviewCacheKeyPrefix — the worker-pool cache follows the patch contents', () => {
  const patch =
    'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-const b = 1;\n+const b = 2;\n';

  test('is the same for the same patch, so a re-render reuses its highlighting', () => {
    expect(reviewCacheKeyPrefix(patch)).toBe(reviewCacheKeyPrefix(`${patch}`));
    expect(reviewCacheKeyPrefix(patch)).toMatch(/^review-[0-9a-z]+$/);
  });

  test('changes when the patch changes, so a changed file is not drawn from the old render', () => {
    expect(reviewCacheKeyPrefix(patch.replace('= 2', '= 3'))).not.toBe(
      reviewCacheKeyPrefix(patch)
    );
  });
});
