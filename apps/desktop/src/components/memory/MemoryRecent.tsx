import type { ApiClient } from '@dispatch/client';
import { useQuery } from '@tanstack/react-query';

import { activityItems, memoryQueryKey } from '../../lib/memory';
import { MemoryActivityList } from './MemoryActivityList';
import { GroupHeader } from '@/ui/ai/group-header';

/** The caller's own personal-memory activity from the last day, each entry's
 *  latest change with an Undo. Hidden when there is none, or when the daemon
 *  answers no activity for this caller (no memory, or no human behind the window). */
export function MemoryRecent({
  client,
  port,
}: {
  client: Pick<ApiClient, 'memoryActivity' | 'undoMemory'>;
  port: number | undefined;
}) {
  const { data } = useQuery({
    queryKey: memoryQueryKey(port, 'activity'),
    queryFn: () => client.memoryActivity(),
    retry: false,
  });
  const items = activityItems(data?.activity ?? []);
  if (items.length === 0) return null;
  return (
    <section
      aria-label="Your memory"
      className="shadow-hairline-top flex max-h-[40%] min-h-0 shrink-0 flex-col overflow-y-auto px-2 py-1"
    >
      <GroupHeader name="Your memory" count={items.length} />
      <MemoryActivityList items={items} client={client} />
      <p className="font-book text-muted-foreground px-2 py-1 text-[12px]">
        Showing the last day. Undo reverts an entry’s latest change. For one
        changed earlier, run{' '}
        <code className="font-mono text-[12px]">
          dispatch memory undo &lt;handle&gt;
        </code>
        ;{' '}
        <code className="font-mono text-[12px]">
          dispatch memory list --scope personal --state all
        </code>{' '}
        lists handles.
      </p>
    </section>
  );
}
