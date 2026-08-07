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

/** The code on lines `startLine`..`endLine` (1-based, inclusive) of `contents` — what a snippet
 * carries so the message still says what it was about after the branch moves. */
export function snippetText(
  contents: string,
  startLine: number,
  endLine: number
): string {
  const lines = contents.split('\n');
  return lines
    .slice(Math.max(0, startLine - 1), Math.max(0, endLine))
    .join('\n');
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
