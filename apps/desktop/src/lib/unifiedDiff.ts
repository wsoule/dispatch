/**
 * A line-level reading of a unified diff.
 *
 * The app renders diffs through `@pierre/diffs`, which is good at showing a patch and owns its
 * own markup — but it exposes no per-line hook, so a comment cannot be anchored to a line inside
 * it. This parser exists so the review surface can render its own rows and put a thread under
 * the exact line it belongs to. It is deliberately small: enough to walk a patch and know each
 * row's kind, its old and new line numbers, and its text.
 */

export type DiffRowKind = 'context' | 'add' | 'del' | 'hunk' | 'meta';

export interface DiffRow {
  kind: DiffRowKind;
  /** Line number on the old side, or null on an added line. */
  oldLine: number | null;
  /** Line number on the new side, or null on a removed line. */
  newLine: number | null;
  /** The line's content, without its leading +/-/space marker. */
  text: string;
}

export interface DiffFileRows {
  path: string;
  rows: DiffRow[];
  additions: number;
  deletions: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/** Pulls the b-side path out of a `diff --git a/x b/x` line, falling back to the a-side. */
function pathFromHeader(line: string): string | null {
  const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
  return match?.[2] ?? match?.[1] ?? null;
}

/**
 * Parses a multi-file unified patch into per-file rows.
 *
 * Tolerant of what git actually emits around the edges — mode changes, binary markers, renames —
 * by treating anything it does not recognise inside a file as `meta` rather than failing. A diff
 * that half-renders is far better than a review surface that shows nothing because one file had
 * an unusual header.
 */
export function parseUnifiedDiff(patch: string): DiffFileRows[] {
  const files: DiffFileRows[] = [];
  let current: DiffFileRows | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of patch.split('\n')) {
    const headerPath = pathFromHeader(line);
    if (headerPath !== null) {
      current = { path: headerPath, rows: [], additions: 0, deletions: 0 };
      files.push(current);
      continue;
    }
    if (current === null) continue;

    const hunk = line.match(HUNK);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      current.rows.push({
        kind: 'hunk',
        oldLine: null,
        newLine: null,
        text: line,
      });
      continue;
    }

    // Header noise between the `diff --git` line and the first hunk: ---/+++/index/mode/similarity.
    if (
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('index ') ||
      line.startsWith('old mode') ||
      line.startsWith('new mode') ||
      line.startsWith('deleted file') ||
      line.startsWith('new file') ||
      line.startsWith('similarity index') ||
      line.startsWith('rename ') ||
      line.startsWith('Binary files')
    ) {
      current.rows.push({
        kind: 'meta',
        oldLine: null,
        newLine: null,
        text: line,
      });
      continue;
    }

    if (line.startsWith('+')) {
      current.rows.push({
        kind: 'add',
        oldLine: null,
        newLine,
        text: line.slice(1),
      });
      newLine += 1;
      current.additions += 1;
      continue;
    }
    if (line.startsWith('-')) {
      current.rows.push({
        kind: 'del',
        oldLine,
        newLine: null,
        text: line.slice(1),
      });
      oldLine += 1;
      current.deletions += 1;
      continue;
    }
    // `\ No newline at end of file` belongs to the line above and advances neither counter.
    if (line.startsWith('\\')) {
      current.rows.push({
        kind: 'meta',
        oldLine: null,
        newLine: null,
        text: line,
      });
      continue;
    }
    if (line === '') continue;

    current.rows.push({
      kind: 'context',
      oldLine,
      newLine,
      text: line.startsWith(' ') ? line.slice(1) : line,
    });
    oldLine += 1;
    newLine += 1;
  }

  return files;
}

/**
 * Collapses long unchanged stretches into a single foldable row.
 *
 * A review only cares about the changes and the few lines either side; showing four hundred
 * untouched lines between two hunks buries them. Returns the rows with runs longer than
 * `context * 2` replaced by a marker the caller can expand.
 */
export interface FoldedRun {
  kind: 'fold';
  /** How many rows this fold is hiding. */
  count: number;
  rows: DiffRow[];
}

export type FoldableRow = DiffRow | FoldedRun;

export function foldContext(rows: DiffRow[], context = 3): FoldableRow[] {
  const out: FoldableRow[] = [];
  let run: DiffRow[] = [];

  const flush = (atEnd: boolean) => {
    if (run.length === 0) return;
    // Keep `context` rows on each side of the fold; only collapse when doing so actually hides
    // something, otherwise a fold row would replace fewer lines than it occupies.
    const keepBefore = out.length === 0 ? 0 : context;
    const keepAfter = atEnd ? 0 : context;
    if (run.length > keepBefore + keepAfter + 1) {
      out.push(...run.slice(0, keepBefore));
      const hidden = run.slice(keepBefore, run.length - keepAfter);
      out.push({ kind: 'fold', count: hidden.length, rows: hidden });
      out.push(...run.slice(run.length - keepAfter));
    } else {
      out.push(...run);
    }
    run = [];
  };

  for (const row of rows) {
    if (row.kind === 'context') {
      run.push(row);
      continue;
    }
    flush(false);
    out.push(row);
  }
  flush(true);
  return out;
}
