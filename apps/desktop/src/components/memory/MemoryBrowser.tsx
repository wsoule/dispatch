import type { MemoryProposalView } from '@dispatch/client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import type { MemoryTabs } from '../../lib/memory';
import { memoryQueryKey, memoryTabs } from '../../lib/memory';
import { MemoryEntryPanel } from './MemoryEntryPanel';
import { MemoryList } from './MemoryList';

type Tab = keyof MemoryTabs | 'proposals';

const TABS: { id: Tab; label: string }[] = [
  { id: 'personal', label: 'Personal' },
  { id: 'project', label: 'Project' },
  { id: 'team', label: 'Team' },
  { id: 'proposals', label: 'Proposals' },
  { id: 'stale', label: 'Stale' },
];

/**
 * Settings › Memory's lessons (memory Task 29): Personal, Project and Team
 * entries, open Proposals, and Stale ones, with an entry's provenance,
 * history and actions under the list. Team includes entries replicated from
 * teammates' machines.
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
      <p className="text-muted-foreground p-3 text-[12px]">
        {messageAccess.explanation ?? 'Memory needs a teammate or app token.'}
      </p>
    );
  const tabs = memoryTabs(entries.data?.entries ?? []);
  const shown = tab === 'proposals' ? [] : tabs[tab];
  const open = shown.find((e) => e.id === selected) ?? null;
  const viewer = { canDecide: messageAccess.canDecide, me: me ?? '' };
  return (
    <div data-testid="memory-browser" className="flex min-w-0 flex-col">
      <div className="flex min-w-0 flex-col">
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
        <div className="max-h-80 overflow-auto">
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
      <div className="min-w-0 border-t">
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

// Open proposals; each is decided through its memory gate.
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
            {`${p.action} to ${p.scope} · by ${p.author} · decide it in Needs you`}
          </span>
        </li>
      ))}
    </ul>
  );
}
