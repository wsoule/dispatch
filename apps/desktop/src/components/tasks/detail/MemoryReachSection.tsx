import type { ApiClient } from '@dispatch/client';
import { useQuery } from '@tanstack/react-query';

import { entryProvenance, memoryQueryKey } from '../../../lib/memory';
import { Markdown } from '../../runs/Markdown';
import { MainSection } from './MainSection';

// The daemon's largest list page; a full page may mean more reach the task.
const LIST_LIMIT = 200;

interface MemoryReachSectionProps {
  client: Pick<ApiClient, 'listMemory'>;
  port: number | undefined;
  taskId: string;
}

/** The memory entries the caller may see that reach this task (named for it,
 *  for its epic, or for every run), read-only, each with where it came from. */
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
      <p data-slot="load-error" className="text-red font-book text-[12px]">
        Couldn&rsquo;t load memory: {error.message}
      </p>
    );
  }
  const entries = data?.entries ?? [];
  if (entries.length === 0) return null;
  return (
    <MainSection
      title="Memory"
      trailing={
        <span className="text-muted-foreground font-book text-[12px] tabular-nums">
          {entries.length >= LIST_LIMIT
            ? `first ${LIST_LIMIT}`
            : entries.length}
        </span>
      }
    >
      <ul className="flex flex-col gap-2">
        {entries.map((entry) => (
          <li
            key={entry.id}
            data-slot="memory-entry"
            className="bg-surface-quaternary rounded-card border-border-strong border-[0.5px] p-3"
          >
            {/* The body stays collapsed under its title, so the list stays dense. */}
            <details>
              <summary className="cursor-pointer">
                {/* Titles are author-written, so they render as plain text. */}
                <span className="text-foreground text-[13px] font-medium break-words">
                  {entry.title}
                </span>
                <span className="text-muted-foreground font-book mt-0.5 block text-[12px]">
                  {entryProvenance(entry)}
                </span>
              </summary>
              <Markdown
                content={entry.body}
                className="text-muted-foreground font-book mt-1 text-[13px]"
              />
            </details>
          </li>
        ))}
      </ul>
    </MainSection>
  );
}
