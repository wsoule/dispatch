import { useQueryClient } from '@tanstack/react-query';
import { BookText } from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

import { DocList } from '../components/docs/DocList';
import { DocPage } from '../components/docs/DocPage';
import { NewDocDialog } from '../components/docs/NewDocDialog';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { docsKey, useDocList, useDocSearch } from '../hooks/useDocs';
import type { DocFilter } from '../lib/docs';
import { filterDocs } from '../lib/docs';
import type { RefAction } from '../lib/threadSources';
import { Button } from '@/ui/button';

// The most search hits a query asks the daemon for.
const SEARCH_LIMIT = 50;

// Team documents beside tasks: a filtered list on the left, the open doc on the right.
// `initialDoc` and `initialAnchor` are what navigation names; `onSelectDoc` hears list picks.
export function DocsView({
  data,
  initialDoc = null,
  initialAnchor = null,
  initialMerge = null,
  onSelectDoc,
  onOpenRef,
  discussion,
}: {
  data: DispatchProjectData;
  /** The open doc's discussion, under it (Two views). */
  discussion?: (docId: string) => ReactNode;
  initialDoc?: string | null;
  initialAnchor?: string | null;
  /** A conflicting proposal whose marked merge the named doc opens on. */
  initialMerge?: string | null;
  onSelectDoc?: (docId: string) => void;
  /** Opens a doc link's target, as a thread's ref chip would. */
  onOpenRef?: (action: RefAction) => void;
}) {
  const { client, port, messageAccess, runs } = data;
  const taskIdOfRun = useMemo(() => {
    const byRun = new Map(runs.map((r) => [r.id, r.taskId]));
    return (runId: string) => byRun.get(runId) ?? null;
  }, [runs]);
  const gates = useMemo(
    () => ({
      availability: data.scopeDecide,
      onRestartDaemon: data.handleRestartDaemon,
    }),
    [data.scopeDecide, data.handleRestartDaemon]
  );
  const [filter, setFilter] = useState<DocFilter>({
    query: '',
    scope: 'all',
    status: 'active',
    unreviewedOnly: false,
  });
  const [open, setOpen] = useState<string | null>(initialDoc);
  const [anchor, setAnchor] = useState<string | null>(initialAnchor);
  const [merge, setMerge] = useState<string | null>(initialMerge);
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient();
  // A doc named while the view is up (a ref, a palette hit) replaces the open one.
  const [named, setNamed] = useState({
    doc: initialDoc,
    anchor: initialAnchor,
    merge: initialMerge,
  });
  if (
    named.doc !== initialDoc ||
    named.anchor !== initialAnchor ||
    named.merge !== initialMerge
  ) {
    setNamed({ doc: initialDoc, anchor: initialAnchor, merge: initialMerge });
    if (initialDoc !== null) {
      setOpen(initialDoc);
      setAnchor(initialAnchor);
      setMerge(initialMerge);
    }
  }
  const select = (id: string): void => {
    setOpen(id);
    setAnchor(null);
    setMerge(null);
    onSelectDoc?.(id);
  };
  const listClient = messageAccess.canMessage ? client : null;
  const { docs, error, loading } = useDocList(listClient, port, {
    includeArchived: filter.status === 'archived',
    limit: 200,
  });
  // A query also matches the docs whose text the daemon's search finds.
  const query = filter.query.trim();
  const hits = useDocSearch(listClient, port, query, SEARCH_LIMIT);
  const shown = useMemo(() => {
    if (query === '') return filterDocs(docs, filter);
    const found = new Set(hits.map((h) => h.doc));
    const byTitle = new Set(filterDocs(docs, filter).map((d) => d.id));
    return filterDocs(docs, { ...filter, query: '' }).filter(
      (d) => found.has(d.id) || byTitle.has(d.id)
    );
  }, [docs, filter, hits, query]);
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
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => setCreating(true)}
          >
            New doc
          </Button>
        </header>
        <NewDocDialog
          client={client}
          open={creating}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            void queryClient.invalidateQueries({ queryKey: docsKey(port) });
            select(id);
          }}
        />
        <DocList
          docs={shown}
          loading={loading}
          filter={filter}
          onFilter={setFilter}
          selected={open}
          onSelect={select}
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
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1 overflow-hidden">
              <DocPage
                key={open}
                client={client}
                port={port}
                refId={open}
                canDecide={messageAccess.canDecide}
                anchor={anchor}
                mergeProposal={merge}
                onOpenDoc={select}
                onOpenRef={onOpenRef}
                taskIdOfRun={taskIdOfRun}
                gates={gates}
              />
            </div>
            {discussion !== undefined && (
              <section
                aria-label="Discussion"
                className="border-border h-[38%] shrink-0 border-t-[0.5px]"
              >
                {discussion(open)}
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
