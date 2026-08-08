import type { FileDiffMetadata } from '@pierre/diffs';

/**
 * Where a new-file line number sits in `additionLines`, or `null` if the patch doesn't carry it.
 *
 * A patch's `additionLines` holds only the lines its hunks cover, so the number is not the index:
 * each hunk maps `additionStart .. additionStart + additionCount - 1` onto `additionLineIndex`
 * onwards.
 */
function indexOfLine(fileDiff: FileDiffMetadata, line: number): number | null {
  for (const hunk of fileDiff.hunks) {
    const offset = line - hunk.additionStart;
    if (offset >= 0 && offset < hunk.additionCount) {
      return hunk.additionLineIndex + offset;
    }
  }
  // No whole-file fallback: `CodeView` hydrates through `hydratePartialDiff('clone', …)`, so the
  // metadata this reads stays partial and a line outside every hunk is never carried here.
  return null;
}

/**
 * The text of `startLine..endLine` (inclusive, additions side) of `file`, read straight out of
 * the already-parsed patch.
 *
 * Synchronous and total by design: this runs inside a click handler that arms the selection
 * action bar, so it must never fetch, never read the DOM and never throw. Lines the patch does
 * not carry are skipped and an unknown file is `''` — an armed bar with an empty snippet is
 * recoverable, a bar that never appears is not.
 */
export function lineTextFromPatch(
  files: readonly FileDiffMetadata[],
  file: string,
  startLine: number,
  endLine: number
): string {
  const fileDiff = files.find((f) => f.name === file);
  if (fileDiff === undefined) return '';
  const first = Math.min(startLine, endLine);
  const last = Math.max(startLine, endLine);
  const lines: string[] = [];
  for (let line = first; line <= last; line += 1) {
    const index = indexOfLine(fileDiff, line);
    if (index === null) continue;
    const text = fileDiff.additionLines[index];
    if (text === undefined) continue;
    // Pierre keeps each line's own terminator; the caller wants a plain block of code.
    lines.push(text.replace(/\r?\n$/, ''));
  }
  return lines.join('\n');
}
