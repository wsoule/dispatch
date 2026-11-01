import { FileIcon } from 'lucide-react';

import type { ChangedFile } from '@/lib/changedFiles';

/**
 * T3 Code's changed-files card at the end of a turn: a soft secondary card listing each
 * file the run edited, with its +/- line counts in the diff hues. Counts come from the
 * edit payloads (`changedFilesFromLog`), so it is a summary, not the review diff.
 */
export function ChangedFilesCard({ files }: { files: readonly ChangedFile[] }) {
  if (files.length === 0) return null;
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  return (
    <section
      aria-label="Changed files"
      data-slot="changed-files"
      className="bg-secondary dark:bg-input/20 rounded-lg p-1"
    >
      <header className="text-muted-foreground flex h-7 items-center gap-2 px-2 text-[12px] font-medium">
        <span>
          {files.length} {files.length === 1 ? 'file' : 'files'} changed
        </span>
        <DiffStat added={added} removed={removed} />
      </header>
      <ul className="flex flex-col">
        {files.map((file) => (
          <li
            key={file.path}
            className="flex h-7 min-w-0 items-center gap-2 rounded-md px-2"
          >
            <FileIcon
              aria-hidden
              className="text-muted-foreground size-3.5 shrink-0"
            />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
              {file.path}
            </span>
            <DiffStat added={file.added} removed={file.removed} />
          </li>
        ))}
      </ul>
    </section>
  );
}

// Nothing to count (an edit logged without its strings) draws nothing, never "+0 −0".
function DiffStat({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null;
  return (
    <span className="ms-auto flex shrink-0 gap-1.5 font-mono text-[11px] tabular-nums">
      <span className="text-green">+{added}</span>
      <span className="text-red">−{removed}</span>
    </span>
  );
}
