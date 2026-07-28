import { describe, expect, test } from 'bun:test';

import type { DiffRow } from './unifiedDiff';
import { foldContext, parseUnifiedDiff } from './unifiedDiff';

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,5 +1,6 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
 export { a };
`;

describe('parseUnifiedDiff', () => {
  test('reads one file with its rows and counts', () => {
    const files = parseUnifiedDiff(PATCH);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('src/a.ts');
    expect(files[0]?.additions).toBe(2);
    expect(files[0]?.deletions).toBe(1);
  });

  // The line numbers are the whole reason this parser exists — a comment anchors to one.
  test('tracks old and new line numbers across an edit', () => {
    const rows = parseUnifiedDiff(PATCH)[0]?.rows ?? [];
    const byText = (t: string): DiffRow | undefined =>
      rows.find((r) => r.text === t);

    expect(byText('const a = 1;')).toMatchObject({ oldLine: 1, newLine: 1 });
    expect(byText('const b = 2;')).toMatchObject({
      kind: 'del',
      oldLine: 2,
      newLine: null,
    });
    expect(byText('const b = 3;')).toMatchObject({
      kind: 'add',
      oldLine: null,
      newLine: 2,
    });
    expect(byText('const c = 4;')).toMatchObject({ kind: 'add', newLine: 3 });
    // The context line after two adds and one delete: old side advanced once, new side thrice.
    expect(byText('const d = 5;')).toMatchObject({ oldLine: 3, newLine: 4 });
  });

  test('handles several files in one patch', () => {
    const files = parseUnifiedDiff(
      `${PATCH}diff --git a/src/b.ts b/src/b.ts\n@@ -1 +1 @@\n-x\n+y\n`
    );
    expect(files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  test('a new file parses without an old-side number on its adds', () => {
    const files = parseUnifiedDiff(
      'diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n'
    );
    const adds = files[0]?.rows.filter((r) => r.kind === 'add') ?? [];
    expect(adds.map((r) => r.newLine)).toEqual([1, 2]);
    expect(adds.every((r) => r.oldLine === null)).toBe(true);
  });

  // A review surface that renders nothing because one file had an unusual header is worse than
  // one that renders the rest and treats the oddity as noise.
  test('unrecognised headers become meta rather than breaking the file', () => {
    const files = parseUnifiedDiff(
      'diff --git a/x b/x\nsimilarity index 92%\nrename from y\nrename to x\n@@ -1 +1 @@\n-a\n+b\n'
    );
    expect(files[0]?.rows.some((r) => r.kind === 'add')).toBe(true);
  });

  test('a binary file yields a file entry with no rows to comment on', () => {
    const files = parseUnifiedDiff(
      'diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n'
    );
    expect(files[0]?.path).toBe('img.png');
    expect(files[0]?.rows.some((r) => r.kind === 'add')).toBe(false);
  });

  test('a no-newline marker does not advance the line counters', () => {
    const files = parseUnifiedDiff(
      'diff --git a/x b/x\n@@ -1,2 +1,2 @@\n-a\n+b\n\\ No newline at end of file\n c\n'
    );
    const context = files[0]?.rows.find((r) => r.kind === 'context');
    expect(context).toMatchObject({ oldLine: 2, newLine: 2 });
  });

  test('an empty patch yields nothing', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});

function ctx(n: number): DiffRow {
  return { kind: 'context', oldLine: n, newLine: n, text: `line ${n}` };
}
const ADD: DiffRow = { kind: 'add', oldLine: null, newLine: 1, text: '+' };

describe('foldContext', () => {
  test('collapses a long unchanged run', () => {
    const rows = [ADD, ...Array.from({ length: 20 }, (_, i) => ctx(i)), ADD];
    const folded = foldContext(rows, 3);
    const fold = folded.find((r) => r.kind === 'fold');
    expect(fold).toBeDefined();
    // 20 context rows, 3 kept either side of the fold.
    expect(fold?.kind === 'fold' && fold.count).toBe(14);
  });

  // A fold row that replaces two lines occupies as much space as it saves.
  test('leaves a short run alone rather than folding fewer lines than it costs', () => {
    const rows = [ADD, ctx(1), ctx(2), ADD];
    expect(foldContext(rows, 3).some((r) => r.kind === 'fold')).toBe(false);
  });

  test('a fold keeps the hidden rows so expanding needs no reparse', () => {
    const rows = [ADD, ...Array.from({ length: 20 }, (_, i) => ctx(i)), ADD];
    const fold = foldContext(rows, 3).find((r) => r.kind === 'fold');
    expect(fold?.kind === 'fold' && fold.rows).toHaveLength(14);
  });

  // Nothing precedes the first run, so there is no "before" context worth keeping — the fold
  // should start at the top of the file rather than stranding three arbitrary lines.
  test('a leading run keeps no context before it', () => {
    const rows = [...Array.from({ length: 20 }, (_, i) => ctx(i)), ADD];
    const folded = foldContext(rows, 3);
    expect(folded[0]?.kind).toBe('fold');
  });

  test('a trailing run keeps no context after it', () => {
    const rows = [ADD, ...Array.from({ length: 20 }, (_, i) => ctx(i))];
    expect(foldContext(rows, 3).at(-1)?.kind).toBe('fold');
  });

  test('a diff of only changes is returned untouched', () => {
    expect(foldContext([ADD, ADD], 3)).toHaveLength(2);
  });
});
