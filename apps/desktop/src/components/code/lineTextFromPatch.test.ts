import type { FileDiffMetadata } from '@pierre/diffs';
import { parsePatchFiles } from '@pierre/diffs';
import { describe, expect, it } from 'bun:test';

import { lineTextFromPatch } from './lineTextFromPatch';

// A real patch put through Pierre's own parser, not a hand-built `FileDiffMetadata`: the whole
// point of this module is that it reads the shape `parsePatchFiles` actually produces, and a
// fixture written to match the implementation would prove nothing about that.
const PATCH = `diff --git a/a.ts b/a.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/a.ts
@@ -1,4 +1,5 @@
 const a = 0;
-const b = 1;
+const b = 2;
+const c = 3;
 const d = 4;
 const e = 5;
@@ -20,3 +21,4 @@ function f() {
   keep();
+  added();
   tail();
   end();
`;

function parse(patch = PATCH): FileDiffMetadata[] {
  return parsePatchFiles(patch).flatMap((p) => p.files);
}

describe('lineTextFromPatch', () => {
  it('reads a single line by its new-file number', () => {
    expect(lineTextFromPatch(parse(), 'a.ts', 3, 3)).toBe('const c = 3;');
  });

  it('joins an inclusive multi-line range', () => {
    expect(lineTextFromPatch(parse(), 'a.ts', 2, 4)).toBe(
      'const b = 2;\nconst c = 3;\nconst d = 4;'
    );
  });

  // The second hunk starts at new-file line 21 but at index 5 of `additionLines` — a patch's
  // `additionLines` holds only the lines the hunks carry, so line numbers are not indices.
  it('reads a line from a later hunk, past the collapsed gap', () => {
    expect(lineTextFromPatch(parse(), 'a.ts', 21, 22)).toBe(
      '  keep();\n  added();'
    );
  });

  // Line 7 sits in the collapsed gap between the two hunks, and its 1-based position (index 6)
  // is a real entry in `additionLines` — so a reader that treated the number as an index would
  // hand back the wrong line's text rather than nothing.
  it('returns empty for a line the patch does not carry', () => {
    expect(lineTextFromPatch(parse(), 'a.ts', 7, 7)).toBe('');
    expect(lineTextFromPatch(parse(), 'a.ts', 900, 900)).toBe('');
  });

  it('returns empty for a file id the patch does not contain', () => {
    expect(lineTextFromPatch(parse(), 'nope.ts', 1, 1)).toBe('');
  });

  it('keeps the lines it has when a range runs off the end of the patch', () => {
    expect(lineTextFromPatch(parse(), 'a.ts', 24, 26)).toBe('  end();');
  });

  it('takes a reversed range the same way as a forward one', () => {
    expect(lineTextFromPatch(parse(), 'a.ts', 4, 2)).toBe(
      'const b = 2;\nconst c = 3;\nconst d = 4;'
    );
  });

  it('returns empty for an empty file list', () => {
    expect(lineTextFromPatch([], 'a.ts', 1, 1)).toBe('');
  });
});
