import type { NormalizedEntry } from '@dispatch/client';

/** One file a run touched, with line counts approximated from its edit payloads. */
export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);

function text(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function lineCount(value: string | undefined): number {
  if (value === undefined || value === '') return 0;
  return value.replace(/\n$/, '').split('\n').length;
}

/**
 * The files a run's own edit calls touched, in first-touched order, for the transcript's
 * changed-files card. Counts are the edit payloads' line counts (old string removed, new
 * string or written content added), the same approximation the inline edit diff draws —
 * not a git diff. Failed calls and calls without a path are skipped.
 */
export function changedFilesFromLog(
  entries: readonly NormalizedEntry[]
): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  for (const entry of entries) {
    if (entry.kind !== 'tool' || entry.status === 'error') continue;
    if (!EDIT_TOOLS.has(entry.toolName ?? '')) continue;
    const path = text(entry.toolInput, 'file_path');
    if (path === undefined) continue;
    const file = files.get(path) ?? { path, added: 0, removed: 0 };
    if (entry.toolName === 'Write') {
      file.added += lineCount(text(entry.toolInput, 'content'));
    } else {
      file.added += lineCount(text(entry.toolInput, 'new_string'));
      file.removed += lineCount(text(entry.toolInput, 'old_string'));
    }
    files.set(path, file);
  }
  return [...files.values()];
}
