import type { Snippet } from '@dispatch/client';

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
