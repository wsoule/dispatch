import type { ApiClient } from '@dispatch/client';
import { TaskDetailSection } from '@dispatch/ui';
import { useQuery } from '@tanstack/react-query';

import { entryProvenance, memoryQueryKey } from '../../../lib/memory';
import styles from './sections.module.css';

const LIST_LIMIT = 200;

/** Memory this task's runs wrote: the lessons it leaves behind, read-only. */
export function TaskLessonsSection({
  client,
  port,
  runIds,
}: {
  client: Pick<ApiClient, 'listMemory'>;
  port: number | undefined;
  runIds: readonly string[];
}) {
  const { data } = useQuery({
    queryKey: memoryQueryKey(port, 'lessons'),
    queryFn: () => client.listMemory({ state: 'all', limit: LIST_LIMIT }),
    retry: false,
  });
  const authors = new Set(runIds.map((id) => `run:${id}`));
  const lessons = (data?.entries ?? []).filter((e) => authors.has(e.author));
  if (lessons.length === 0) return null;
  return (
    <TaskDetailSection
      title="Lessons from this task"
      headingLevel={3}
      count={lessons.length}
    >
      <ul data-testid="task-lessons" className={styles.lessons}>
        {lessons.map((entry) => (
          <li key={entry.id} className={styles.lesson}>
            <span className={styles.lessonTitle}>{entry.title}</span>
            <span className={styles.cardLine}>
              {entryProvenance(entry)}
              {entry.status === 'retired' ? ' · retired' : ''}
            </span>
          </li>
        ))}
      </ul>
    </TaskDetailSection>
  );
}
