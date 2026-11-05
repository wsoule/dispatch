import type { DocLink } from '@dispatch/client';
import { Chip, ChipButton } from '@dispatch/ui';
import { useId } from 'react';

import type { RefAction } from '../../lib/threadSources';
import { refAction } from '../../lib/threadSources';
import styles from './DocLinksRail.module.css';

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
// target as `type:id` with its rel; a target with a page is a chip button
// that opens it through `onOpen`, one without stays a plain chip. The rail
// and its list are both named by the visible "Links" heading.
export function DocLinksRail({
  links,
  onOpen,
  taskIdOfRun = () => null,
}: {
  links: readonly DocLink[];
  onOpen?: (action: RefAction) => void;
  taskIdOfRun?: (runId: string) => string | null;
}) {
  const headingId = useId();
  return (
    <aside aria-labelledby={headingId} className={styles.rail}>
      <h3 id={headingId} className={styles.heading}>
        Links
      </h3>
      {links.length === 0 ? (
        <p className={styles.empty}>No links yet.</p>
      ) : (
        <ul aria-labelledby={headingId} className={styles.list}>
          {links.map((l) => {
            const text = `${l.target.type}:${l.target.id}`;
            const action =
              onOpen === undefined
                ? null
                : docLinkAction(l.target, taskIdOfRun);
            return (
              <li key={`${text}:${l.rel}:${l.source}`} className={styles.row}>
                {action === null ? (
                  <Chip tone="muted">
                    <span className="mono">{text}</span>
                  </Chip>
                ) : (
                  <ChipButton
                    data-testid="doc-link"
                    onClick={() => onOpen?.(action)}
                  >
                    <span className="mono">{text}</span>
                  </ChipButton>
                )}
                <span className={styles.rel}>
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
