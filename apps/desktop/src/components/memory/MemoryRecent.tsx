import type { ApiClient } from '@dispatch/client';
import { SectionHeader } from '@dispatch/ui';
import { useQuery } from '@tanstack/react-query';

import { activityItems, memoryQueryKey } from '../../lib/memory';
import { MemoryActivityList } from './MemoryActivityList';
import styles from './MemoryRecent.module.css';

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
    <section aria-label="Your memory" className={styles.root}>
      <SectionHeader as="h2" name="Your memory" count={items.length} />
      <div className={styles.card}>
        <MemoryActivityList items={items} client={client} />
      </div>
      <p className={styles.note}>
        Showing the last day. Undo reverts an entry’s latest change. For one
        changed earlier, run{' '}
        <code className={styles.code}>dispatch memory undo &lt;handle&gt;</code>
        ;{' '}
        <code className={styles.code}>
          dispatch memory list --scope personal --state all
        </code>{' '}
        lists handles.
      </p>
    </section>
  );
}
