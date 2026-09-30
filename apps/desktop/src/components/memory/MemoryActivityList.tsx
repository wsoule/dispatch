import type { ApiClient } from '@dispatch/client';
import { useId, useState } from 'react';

import { formatRelativeTimeFromIso } from '../../lib/format';
import type { MemoryActivityItem } from '../../lib/memory';
import { Button } from '@/ui/button';

type UndoState =
  | { state: 'running' }
  | { state: 'done' }
  | { state: 'failed'; error: string };

interface MemoryActivityListProps {
  items: readonly MemoryActivityItem[];
  client: Pick<ApiClient, 'undoMemory'>;
}

/** What agents wrote to your personal memory, each change with an Undo that
 *  restores the entry's previous revision (a creation is retired). */
export function MemoryActivityList({ items, client }: MemoryActivityListProps) {
  const [undo, setUndo] = useState<ReadonlyMap<string, UndoState>>(new Map());
  const idBase = useId();
  const mark = (id: string, next: UndoState) =>
    setUndo((prev) => new Map(prev).set(id, next));

  async function undoItem(item: MemoryActivityItem) {
    if (item.memoryId === null || undo.get(item.id)?.state === 'running') {
      return;
    }
    mark(item.id, { state: 'running' });
    try {
      await client.undoMemory(item.memoryId);
      mark(item.id, { state: 'done' });
    } catch (err) {
      mark(item.id, {
        state: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <ul className="flex flex-col">
      {items.map((item, index) => {
        const status = undo.get(item.id);
        const summaryId = `${idBase}-${index}-summary`;
        const errorId = `${idBase}-${index}-error`;
        return (
          <li
            key={item.id}
            data-slot="memory-activity"
            className="rounded-control flex items-start gap-2 px-2 py-1.5"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              {/* The daemon's summary carries agent-written titles: plain text only. */}
              <span
                id={summaryId}
                className="text-foreground text-[13px] break-words"
              >
                {item.text}
              </span>
              <time
                dateTime={item.at}
                className="font-book text-muted-foreground text-[12px]"
              >
                {formatRelativeTimeFromIso(item.at)}
              </time>
              {status?.state === 'failed' && (
                <span
                  id={errorId}
                  role="alert"
                  className="text-red text-[12px]"
                >
                  {status.error}
                </span>
              )}
            </div>
            {item.undoable && (
              <Button
                variant="outline"
                size="xs"
                className="shrink-0"
                aria-describedby={
                  status?.state === 'failed'
                    ? `${summaryId} ${errorId}`
                    : summaryId
                }
                disabled={
                  status?.state === 'running' || status?.state === 'done'
                }
                onClick={() => void undoItem(item)}
              >
                {status?.state === 'running'
                  ? 'Undoing…'
                  : status?.state === 'done'
                    ? 'Undone'
                    : 'Undo'}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
