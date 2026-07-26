import { describe, expect, test } from 'bun:test';

import { splitPatchFiles } from './patchFiles';

// A real two-file git patch in the shape dispatchd's diff endpoint returns:
// one modified file and one added file, each with a single hunk.
const TWO_FILE_PATCH = `diff --git a/src/alpha.ts b/src/alpha.ts
index 1111111..2222222 100644
--- a/src/alpha.ts
+++ b/src/alpha.ts
@@ -1,3 +1,4 @@
 export function alpha() {
-  return 1;
+  return 2;
 }
+export const ALPHA = true;
diff --git a/src/beta.ts b/src/beta.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/beta.ts
@@ -0,0 +1,3 @@
+export function beta() {
+  return 'beta';
+}
`;

describe('splitPatchFiles', () => {
  test('splits a two-file patch into two file diffs with their paths', () => {
    const result = splitPatchFiles(TWO_FILE_PATCH);
    expect(result.error).toBeNull();
    expect(result.files).toHaveLength(2);
    expect(result.files.map((f) => f.name)).toEqual([
      'src/alpha.ts',
      'src/beta.ts',
    ]);
  });

  test('returns an error result for a garbage patch instead of throwing', () => {
    const result = splitPatchFiles('this is not a patch at all');
    expect(result.error).not.toBeNull();
    expect(result.files).toHaveLength(0);
  });
});
