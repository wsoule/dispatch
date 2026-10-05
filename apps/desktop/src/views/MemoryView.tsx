import type { MemoryProposalView } from '@dispatch/client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { MemoryEntryPanel } from '../components/memory/MemoryEntryPanel';
import { MemoryList } from '../components/memory/MemoryList';
import { RehomePanel } from '../components/memory/RehomePanel';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { MemoryTabs } from '../lib/memory';
import { memoryQueryKey, memoryTabs } from '../lib/memory';

type Tab = keyof MemoryTabs | 'proposals';

const TABS: { id: Tab; label: string }[] = [
  { id: 'personal', label: 'Personal' },
  { id: 'project', label: 'Project' },
  { id: 'team', label: 'Team' },
  { id: 'proposals', label: 'Proposals' },
  { id: 'stale', label: 'Stale' },
];

/**
 * What runs remember (memory Task 29): Personal, Project and Team entries,
 * open Proposals, and Stale ones, with an entry's provenance, history and
 * actions beside the list. Team includes entries replicated from teammates'
 * machines. Personal also offers re-homing a moved checkout's entries.
 */
export function MemoryView({ data }: { data: DispatchProjectData }) {
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
  if (client === null)
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  if (!messageAccess.canMessage)
    return (
      <p className="p-4 text-xs text-[var(--color-muted-foreground)]">
        {messageAccess.explanation ?? 'Memory needs a teammate or app token.'}
      </p>
    );
  const tabs = memoryTabs(entries.data?.entries ?? []);
  const shown = tab === 'proposals' ? [] : tabs[tab];
  const open = shown.find((e) => e.id === selected) ?? null;
  const viewer = { canDecide: messageAccess.canDecide, me: me ?? '' };
  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[360px] min-w-0 flex-col border-r">
        <div role="tablist" aria-label="Memory" className="flex gap-1 p-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => {
                setTab(t.id);
                setSelected(null);
              }}
              className="rounded-control text-muted-foreground aria-selected:bg-surface-selected aria-selected:text-foreground px-2 py-1 text-[13px]"
            >
              {t.id === 'proposals'
                ? t.label
                : `${t.label} ${tabs[t.id].length}`}
            </button>
          ))}
        </div>
        {tab === 'personal' && (
          <div className="px-2 pb-2">
            <RehomePanel client={client} port={port} />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          {entries.error !== null && (
            <p role="alert" className="text-red p-4 text-[13px]">
              {entries.error.message}
            </p>
          )}
          {tab === 'proposals' ? (
            <ProposalList proposals={proposals.data?.proposals ?? []} />
          ) : (
            <MemoryList
              entries={shown}
              selected={selected}
              onSelect={setSelected}
            />
          )}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        {open !== null && (
          <MemoryEntryPanel
            key={open.id}
            entry={open}
            client={client}
            port={port}
            viewer={viewer}
          />
        )}
      </div>
    </div>
  );
}

// Open proposals; each is decided through its memory gate in Threads.
function ProposalList({
  proposals,
}: {
  proposals: readonly MemoryProposalView[];
}) {
  if (proposals.length === 0)
    return (
      <p className="text-muted-foreground p-4 text-[13px]">
        No proposals wait for a decision.
      </p>
    );
  return (
    <ul aria-label="Memory proposals" className="flex flex-col">
      {proposals.map((p) => (
        <li key={p.id} className="flex flex-col gap-0.5 px-3 py-2">
          <span className="text-foreground text-[13px] break-words">
            {p.content?.title ?? `Retire ${p.target ?? ''}`}
          </span>
          <span className="text-muted-foreground text-[12px]">
            {`${p.action} to ${p.scope} · by ${p.author} · decide it in Threads`}
          </span>
        </li>
      ))}
    </ul>
  );
}
