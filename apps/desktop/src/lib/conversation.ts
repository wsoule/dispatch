import type { Snippet } from '@dispatch/client';

import type { CodeSelection } from '../components/code/SelectionActions';

/** How a snippet reads on its chip. A one-line range shows one number, not `7-7`. */
export function snippetLabel(snippet: Snippet): string {
  const range =
    snippet.startLine === snippet.endLine
      ? `${snippet.startLine}`
      : `${snippet.startLine}-${snippet.endLine}`;
  return `${snippet.file} (${range})`;
}

export function subjectForRun(runId: string): string {
  return `run:${runId}`;
}

/**
 * Which lines of `contents` the reviewer's selected `text` covers, or `null` when that text is
 * not in this file at all — a selection that crossed the deleted side of a split diff, or one
 * taken against contents that have since moved on.
 *
 * Matching the text is how a plain DOM selection becomes a line range: the browser reports what
 * was selected, never where Pierre drew it, so the file itself is the only thing that can say
 * which lines those were. Two identical spans cannot be told apart from the text alone, so the
 * first wins — the snippet carries the exact code either way.
 */
export function locateSnippetLines(
  contents: string,
  text: string
): { startLine: number; endLine: number } | null {
  if (text === '') return null;
  const index = contents.indexOf(text);
  if (index === -1) return null;
  const startLine = contents.slice(0, index).split('\n').length;
  // A drag ending past the end of a row takes that row's newline with it; the newline belongs
  // to the last selected line, not to the untouched line after it.
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return { startLine, endLine: startLine + body.split('\n').length - 1 };
}

/**
 * The one place a selection becomes an attachment. They are deliberately different types — a
 * `CodeSelection` is a live UI gesture, a `Snippet` is what gets persisted — so this conversion
 * lives in the wiring layer and neither the selection bar nor the composer has to know the
 * other exists.
 */
export function snippetFromSelection(selection: CodeSelection): Snippet {
  return {
    file: selection.file,
    startLine: Math.min(selection.startLine, selection.endLine),
    endLine: Math.max(selection.startLine, selection.endLine),
    text: selection.text,
  };
}
