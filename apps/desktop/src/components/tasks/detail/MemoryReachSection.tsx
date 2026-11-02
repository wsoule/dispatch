import type { ApiClient } from '@dispatch/client';
import { cx, TaskDetailSection } from '@dispatch/ui';
import { useQuery } from '@tanstack/react-query';

import { entryProvenance, memoryQueryKey } from '../../../lib/memory';
import { Markdown } from '../../runs/Markdown';
import styles from './sections.module.css';

// The daemon's largest list page; a full page may mean more reach the task.
const LIST_LIMIT = 200;

interface MemoryReachSectionProps {
  client: Pick<ApiClient, 'listMemory'>;
  port: number | undefined;
  taskId: string;
}

/** The memory entries the caller may see that reach this task (named for it,
 *  for its milestone, or for every run), read-only, each with where it came from. */
export function MemoryReachSection({
  client,
  port,
  taskId,
}: MemoryReachSectionProps) {
  const { data, error } = useQuery({
    queryKey: [...memoryQueryKey(port, 'reach'), taskId],
    queryFn: () => client.listMemory({ taskId, limit: LIST_LIMIT }),
    retry: false,
  });
  if (error !== null) {
    return (
      <p
        data-slot="load-error"
        className={cx('toneText', styles.note)}
        data-tone="danger"
      >
        Couldn&rsquo;t load memory: {error.message}
      </p>
    );
  }
  const entries = data?.entries ?? [];
  if (entries.length === 0) return null;
  return (
    <TaskDetailSection
      title="Memory"
      headingLevel={3}
      meta={
        <span className="num">
          {entries.length >= LIST_LIMIT
            ? `first ${LIST_LIMIT}`
            : entries.length}
        </span>
      }
    >
      <ul className={styles.list}>
        {entries.map((entry) => (
          <li key={entry.id} data-slot="memory-entry" className={styles.card}>
            {/* The body stays collapsed under its title, so the list stays dense. */}
            <details>
              <summary className={styles.summary}>
                {/* Titles are author-written, so they render as plain text. */}
                <span className={styles.cardTitle}>{entry.title}</span>
                <span className={styles.cardLine}>
                  {entryProvenance(entry)}
                </span>
              </summary>
              <Markdown content={entry.body} className={styles.markdown} />
            </details>
          </li>
        ))}
      </ul>
    </TaskDetailSection>
  );
}
