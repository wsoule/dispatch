import type { DocLink } from '@dispatch/client';

import type { RefAction } from '../../lib/threadSources';
import { refAction } from '../../lib/threadSources';

/** Where a doc link leads: a thread to its root message, a task, run or doc
 *  as a ref chip would; null for memory or a run no longer listed. */
export function docLinkAction(
  target: DocLink['target'],
  taskIdOfRun: (runId: string) => string | null
): RefAction | null {
  switch (target.type) {
    case 'thread':
      return { kind: 'message', messageId: target.id };
    case 'memory':
      return null;
    default:
      return refAction({ type: target.type, id: target.id }, { taskIdOfRun });
  }
}

// What the doc links to (tasks, runs, threads, memory, docs), one row per
// target as `type:id` with its rel; a target with a page opens through `onOpen`.
export function DocLinksRail({
  links,
  onOpen,
  taskIdOfRun = () => null,
}: {
  links: readonly DocLink[];
  onOpen?: (action: RefAction) => void;
  taskIdOfRun?: (runId: string) => string | null;
}) {
  return (
    <aside
      aria-label="Links"
      className="w-56 shrink-0 overflow-auto border-l border-[var(--color-border)] p-3"
    >
      <h3 className="mb-2 text-xs font-medium text-[var(--color-muted-foreground)]">
        Links
      </h3>
      {links.length === 0 ? (
        <p className="text-xs text-[var(--color-muted-foreground)]">
          No links yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-1 text-xs">
          {links.map((l) => {
            const text = `${l.target.type}:${l.target.id}`;
            const action =
              onOpen === undefined
                ? null
                : docLinkAction(l.target, taskIdOfRun);
            return (
              <li
                key={`${text}:${l.rel}:${l.source}`}
                className="flex items-center gap-1.5"
              >
                {action === null ? (
                  <span className="truncate font-mono">{text}</span>
                ) : (
                  <button
                    type="button"
                    data-testid="doc-link"
                    className="truncate text-left font-mono hover:underline"
                    onClick={() => onOpen?.(action)}
                  >
                    {text}
                  </button>
                )}
                <span className="text-[var(--color-muted-foreground)]">
                  {l.source === 'mention' ? 'mention' : l.rel}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
