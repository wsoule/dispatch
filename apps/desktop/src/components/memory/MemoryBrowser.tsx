import type { MemoryProposalView } from '@dispatch/client';
import { cx, SkeletonRows, Tabs } from '@dispatch/ui';
import { useQuery } from '@tanstack/react-query';
import type { MouseEvent } from 'react';
import { useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import type { MemoryTabs } from '../../lib/memory';
import { memoryQueryKey, memoryTabs } from '../../lib/memory';
import styles from './MemoryBrowser.module.css';
import { MemoryEntryPanel } from './MemoryEntryPanel';
import { MemoryList } from './MemoryList';

type Tab = keyof MemoryTabs | 'proposals';

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'personal', label: 'Personal' },
  { id: 'project', label: 'Project' },
  { id: 'team', label: 'Team' },
  { id: 'proposals', label: 'Proposals' },
  { id: 'stale', label: 'Stale' },
];

/**
 * Docs › Memory's lessons (memory Task 29): Personal, Project and Team
 * entries, open Proposals, and Stale ones, with an entry's provenance,
 * history and actions under the list. Team includes entries replicated from
 * teammates' machines. The library Tabs is controlled here and every tab
 * shows the one host panel below, so picking another tab swaps the list
 * and closes the open entry; picking the selected tab again closes it too.
 */
export function MemoryBrowser({
  data,
}: {
  data: Pick<DispatchProjectData, 'client' | 'port' | 'messageAccess' | 'me'>;
}) {
  const { client, port, messageAccess, me } = data;
  const [tab, setTab] = useState<Tab>('personal');
  const [selected, setSelected] = useState<string | null>(null);
  const ready = client !== null && messageAccess.canMessage;
  const entries = useQuery({
    queryKey: memoryQueryKey(port, 'entries'),
    queryFn: () => {
      if (client === null) throw new Error('no daemon');
      return client.listMemory();
    },
    enabled: ready,
  });
  const proposals = useQuery({
    queryKey: memoryQueryKey(port, 'proposals:open'),
    queryFn: () => {
      if (client === null) throw new Error('no daemon');
      return client.listMemoryProposals('open');
    },
    enabled: ready && tab === 'proposals',
  });
  if (client === null) return null;
  if (!messageAccess.canMessage)
    return (
      <p className={styles.note}>
        {messageAccess.explanation ?? 'Memory needs a teammate or app token.'}
      </p>
    );
  const tabs = memoryTabs(entries.data?.entries ?? []);
  // Until the entries arrive there are no counts to print, and an empty list
  // would read as "Nothing here yet."
  const loading = entries.isPending;
  const shown = tab === 'proposals' ? [] : tabs[tab];
  const open = shown.find((e) => e.id === selected) ?? null;
  const viewer = { canDecide: messageAccess.canDecide, me: me ?? '' };
  return (
    // The click this hears bubbles from a tab button, which Enter and Space
    // click too, so the keyboard reaches it through the tab itself.
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div
      data-testid="memory-browser"
      className={styles.root}
      onClick={(event) => {
        if (pickedSelectedTab(event)) setSelected(null);
      }}
    >
      <Tabs
        flush
        label="Memory"
        value={tab}
        onChange={(id) => {
          const next = TABS.find((t) => t.id === id);
          if (next === undefined) return;
          setTab(next.id);
          setSelected(null);
        }}
        items={TABS.map((t) => ({
          id: t.id,
          label:
            t.id === 'proposals' || loading
              ? t.label
              : `${t.label} ${tabs[t.id].length}`,
        }))}
      >
        <div className={styles.panel}>
          <div className={styles.list}>
            {entries.error !== null && (
              <p
                role="alert"
                className={cx('toneText', styles.error)}
                data-tone="danger"
              >
                {entries.error.message}
              </p>
            )}
            {tab === 'proposals' ? (
              proposals.isPending ? (
                <SkeletonRows rows={3} label="Loading proposals…" />
              ) : (
                <ProposalList proposals={proposals.data?.proposals ?? []} />
              )
            ) : loading ? (
              <SkeletonRows rows={4} label="Loading memory…" />
            ) : (
              <MemoryList
                entries={shown}
                selected={selected}
                onSelect={setSelected}
              />
            )}
          </div>
          {open !== null && (
            <div className={styles.entry}>
              <MemoryEntryPanel
                key={open.id}
                entry={open}
                client={client}
                port={port}
                viewer={viewer}
              />
            </div>
          )}
        </div>
      </Tabs>
    </div>
  );
}

// Whether a click landed on the tab that was already selected. The library
// Tabs reports only a pick of another tab (onChange), but re-picking the
// selected one has always closed the open entry here, so the browser hears
// that click as it bubbles from the strip. A pick of another tab reads
// aria-selected="false" at this point (React re-renders after the event)
// and is handled by onChange.
function pickedSelectedTab(event: MouseEvent<HTMLElement>): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const tab = target.closest('[role="tab"]');
  return (
    tab !== null &&
    event.currentTarget.contains(tab) &&
    tab.getAttribute('aria-selected') === 'true'
  );
}

// Open proposals; each is decided through its memory gate.
function ProposalList({
  proposals,
}: {
  proposals: readonly MemoryProposalView[];
}) {
  if (proposals.length === 0)
    return <p className={styles.empty}>No proposals wait for a decision.</p>;
  return (
    <ul aria-label="Memory proposals" className={styles.proposals}>
      {proposals.map((p) => (
        <li key={p.id} className={styles.proposal}>
          <span className={styles.title}>
            {p.content?.title ?? `Retire ${p.target ?? ''}`}
          </span>
          <span className={styles.meta}>
            {`${p.action} to ${p.scope} · by ${p.author} · decide it in Needs you`}
          </span>
        </li>
      ))}
    </ul>
  );
}
