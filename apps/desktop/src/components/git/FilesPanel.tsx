import { AlertTriangle, Check, FileQuestion, Square } from 'lucide-react';

import type { GitFileRow } from '@/lib/gitPanels';
import { cn } from '@/lib/utils';

const SECTION_LABEL: Record<GitFileRow['section'], string> = {
  conflicted: 'Conflicted',
  staged: 'Staged',
  unstaged: 'Unstaged',
  untracked: 'Untracked',
};

interface FilesPanelProps {
  rows: GitFileRow[];
  selectedIndex: number;
  busyPaths: ReadonlySet<string>;
  onSelectIndex: (index: number) => void;
  onToggleStage: (row: GitFileRow) => void;
}

/** Panel 2: staged/unstaged/untracked/conflicted files as one flat, sectioned list. Each
 * row's leading icon is also a button, so staging never requires the keyboard. */
export function FilesPanel({
  rows,
  selectedIndex,
  busyPaths,
  onSelectIndex,
  onToggleStage,
}: FilesPanelProps) {
  if (rows.length === 0) {
    return (
      <div className="text-muted-foreground p-3 text-[12px]">
        Working tree clean.
      </div>
    );
  }

  let lastSection: GitFileRow['section'] | null = null;

  return (
    <div className="flex flex-col">
      {rows.map((row, index) => {
        const showHeader = row.section !== lastSection;
        lastSection = row.section;
        const busy = busyPaths.has(row.path);
        const selected = index === selectedIndex;
        return (
          <div key={`${row.section}:${row.path}`}>
            {showHeader && (
              <div className="text-muted-foreground px-3 pt-2 pb-1 text-[10px] font-medium tracking-wide uppercase">
                {SECTION_LABEL[row.section]}
              </div>
            )}
            <div
              role="button"
              tabIndex={-1}
              onClick={() => onSelectIndex(index)}
              className={cn(
                'flex cursor-pointer items-center gap-2 px-3 py-1 text-[12px]',
                selected ? 'bg-accent' : 'hover:bg-muted/50'
              )}
            >
              <button
                type="button"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleStage(row);
                }}
                title={
                  row.section === 'staged' ? 'Unstage (space)' : 'Stage (space)'
                }
                className="text-muted-foreground hover:text-foreground grid size-4 shrink-0 place-items-center disabled:opacity-50"
              >
                {row.section === 'conflicted' ? (
                  <AlertTriangle className="text-destructive size-3.5" />
                ) : row.section === 'staged' ? (
                  <Check className="size-3.5" />
                ) : row.section === 'untracked' ? (
                  <FileQuestion className="size-3.5" />
                ) : (
                  <Square className="size-3.5" />
                )}
              </button>
              <span className="truncate font-mono">{row.path}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
