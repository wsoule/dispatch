import type { ApiClient } from '@dispatch/client';
import { useQuery } from '@tanstack/react-query';

import { entryProvenance, memoryQueryKey } from '../../../lib/memory';
import { MainSection } from './MainSection';

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
    <MainSection
      title="Lessons from this task"
      trailing={
        <span className="text-muted-foreground font-book text-[12px] tabular-nums">
          {lessons.length}
        </span>
      }
    >
      <ul data-testid="task-lessons" className="flex flex-col gap-1.5">
        {lessons.map((entry) => (
          <li key={entry.id} className="text-[13px]">
            <span className="font-medium">{entry.title}</span>
            <span className="text-muted-foreground font-book block text-[12px]">
              {entryProvenance(entry)}
              {entry.status === 'retired' ? ' · retired' : ''}
            </span>
          </li>
        ))}
      </ul>
    </MainSection>
  );
}
