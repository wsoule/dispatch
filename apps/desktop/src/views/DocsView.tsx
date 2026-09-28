import { BookText } from 'lucide-react';
import { useState } from 'react';

import { DocList } from '../components/docs/DocList';
import { DocPage } from '../components/docs/DocPage';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { useDocList } from '../hooks/useDocs';
import type { DocFilter } from '../lib/docs';
import { filterDocs } from '../lib/docs';

// Team documents beside tasks: a filtered list on the left, the open doc on the right.
export function DocsView({
  data,
  initialDoc = null,
}: {
  data: DispatchProjectData;
  initialDoc?: string | null;
}) {
  const { client, port, messageAccess } = data;
  const [filter, setFilter] = useState<DocFilter>({
    query: '',
    scope: 'all',
    status: 'active',
    unreviewedOnly: false,
  });
  const [open, setOpen] = useState<string | null>(initialDoc);
  const { docs, error } = useDocList(
    messageAccess.canMessage ? client : null,
    port,
    { includeArchived: filter.status === 'archived', limit: 200 }
  );
  if (client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }
  if (!messageAccess.canMessage) {
    return (
      <p className="p-4 text-xs text-[var(--color-muted-foreground)]">
        {messageAccess.explanation ?? 'Docs need a teammate or app token.'}
      </p>
    );
  }
  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-72 shrink-0 flex-col border-r border-[var(--color-border)]">
        <header className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
          <BookText className="size-4" />
          <h1 className="text-sm font-medium">Docs</h1>
        </header>
        <DocList
          docs={filterDocs(docs, filter)}
          filter={filter}
          onFilter={setFilter}
          selected={open}
          onSelect={setOpen}
          error={error}
        />
      </aside>
      <main className="min-w-0 flex-1">
        {open === null ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-xs text-[var(--color-muted-foreground)]">
            <BookText className="size-4 opacity-50" />
            <p>Pick a doc.</p>
          </div>
        ) : (
          <DocPage
            key={open}
            client={client}
            port={port}
            refId={open}
            canDecide={messageAccess.canDecide}
          />
        )}
      </main>
    </div>
  );
}
