import { Button, SegmentedControl } from '@dispatch/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

import { DocList } from '../components/docs/DocList';
import { DocPage } from '../components/docs/DocPage';
import { NewDocDialog } from '../components/docs/NewDocDialog';
import { MemoryBrowser } from '../components/memory/MemoryBrowser';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import {
  CrumbLink,
  TasksPageHeader,
} from '../components/tasks/TasksPageHeader';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { docsKey, useDocList, useDocSearch } from '../hooks/useDocs';
import type { DocFilter } from '../lib/docs';
import { filterDocs } from '../lib/docs';
import type { RefAction } from '../lib/threadSources';
import styles from './DocsView.module.css';

// The most search hits a query asks the daemon for.
const SEARCH_LIMIT = 50;

// The two things the page lists, one at a time.
const SECTIONS = [
  { id: 'docs', label: 'Docs' },
  { id: 'memory', label: 'Memory' },
];

// Team documents beside tasks, as one page under the Tasks back chip: the All
// docs list, or one doc in its place under an "All docs › title" crumb.
// `initialDoc` and `initialAnchor` are what navigation names; `onSelectDoc`
// hears list picks.
export function DocsView({
  data,
  initialDoc = null,
  initialAnchor = null,
  initialMerge = null,
  onSelectDoc,
  onOpenRef,
  discussion,
  tasksPage,
}: {
  data: DispatchProjectData;
  /** The Tasks back chip leads the header and "All docs" walks back to the list. */
  tasksPage: { onBack: () => void; onOpenAllDocs: () => void };
  /** The open doc's discussion, under it. */
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
  // The doc last opened: its row stays marked when the crumb walks back, so
  // j and k carry on from it.
  const [lastOpen, setLastOpen] = useState<string | null>(initialDoc);
  if (open !== null && open !== lastOpen) setLastOpen(open);
  const [anchor, setAnchor] = useState<string | null>(initialAnchor);
  const [merge, setMerge] = useState<string | null>(initialMerge);
  const [creating, setCreating] = useState(false);
  // The list pane shows docs or the memory runs read, one at a time.
  const [section, setSection] = useState<'docs' | 'memory'>('docs');
  const queryClient = useQueryClient();
  // A doc named while the view is up (a ref, a palette hit) replaces the open
  // one; navigation naming no doc means the list.
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
    setOpen(initialDoc);
    setAnchor(initialAnchor);
    setMerge(initialMerge);
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
  // Every state of the page sits under the one header: the back chip, the
  // crumb and the page's actions.
  const frame = (body: ReactNode, crumb: ReactNode[], actions?: ReactNode) => (
    <div data-testid="docs-page" className={styles.page}>
      <TasksPageHeader
        onBack={tasksPage.onBack}
        crumb={crumb}
        actions={actions}
      />
      <div className={styles.body}>{body}</div>
    </div>
  );
  if (client === null) {
    return frame(
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />,
      ['All docs']
    );
  }
  if (!messageAccess.canMessage) {
    return frame(
      <p className={styles.note}>
        {messageAccess.explanation ?? 'Docs need a teammate or app token.'}
      </p>,
      ['All docs']
    );
  }
  if (open !== null) {
    const title = docs.find((d) => d.id === open)?.title ?? 'Doc';
    return frame(
      <div className={styles.doc}>
        <div className={styles.docMain}>
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
          <section aria-label="Discussion" className={styles.discussion}>
            {discussion(open)}
          </section>
        )}
      </div>,
      [
        <CrumbLink
          key="all"
          onClick={() => {
            setOpen(null);
            tasksPage.onOpenAllDocs();
          }}
        >
          All docs
        </CrumbLink>,
        title,
      ]
    );
  }
  const sectionToggle = (
    <SegmentedControl
      label="Docs or memory"
      size="sm"
      options={SECTIONS}
      value={section}
      onChange={(id) => setSection(id === 'memory' ? 'memory' : 'docs')}
    />
  );
  if (section === 'memory') {
    return frame(
      <div className={styles.scroll}>
        <MemoryBrowser data={data} />
      </div>,
      ['Memory'],
      sectionToggle
    );
  }
  return frame(
    <>
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
        selected={lastOpen}
        onSelect={select}
        error={error}
        onNew={() => setCreating(true)}
      />
    </>,
    ['All docs'],
    <>
      {sectionToggle}
      <Button
        variant="quiet"
        size="sm"
        icon={<Plus size={14} strokeWidth={1.8} aria-hidden />}
        onClick={() => setCreating(true)}
      >
        New doc
      </Button>
    </>
  );
}
