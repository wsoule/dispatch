import type { AgentStatus, AgentSummary, ApiClient } from '@dispatch/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Bell, BellOff, Check } from 'lucide-react';
import type { ReactElement } from 'react';
import { useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { agentRosterKey } from '../../hooks/useDispatchProject';
import { handleOf, rosterActions, sortRoster } from '../../lib/agentRoster';
import { isInsufficientTier } from '../../lib/daemonAuth';
import { useSettingsAccess } from './access';
import { SettingsSearchable } from './search';
import { SettingsGroup, SettingsRow } from './SettingsGroup';
import { IconButton } from '@/ui/ai/icon-button';
import { InitialsAvatar } from '@/ui/ai/initials-avatar';
import { LabelPill, Pill } from '@/ui/ai/pill';
import type { RecordsColumn } from '@/ui/ai/records-table';
import { RecordsTable } from '@/ui/ai/records-table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

interface AgentRosterSectionProps {
  data: DispatchProjectData;
}

const STATUS_PILL: Record<AgentStatus, { label: string; color: string }> = {
  pending: { label: 'Pending', color: 'var(--state-waiting-fg)' },
  approved: { label: 'Approved', color: 'var(--state-review-fg)' },
  revoked: { label: 'Revoked', color: 'var(--state-failed-fg)' },
};

const COLUMNS: RecordsColumn[] = [
  { key: 'address', label: 'Address' },
  { key: 'client', label: 'Client', slot: 'title' },
  { key: 'status', label: 'Status' },
  { key: 'approvedBy', label: 'Approved by' },
  { key: 'actions', label: 'Actions' },
  { key: 'createdAt', label: 'Added', kind: 'time' },
];

/** One row action: an icon button whose tooltip names it, or says why it is
 *  locked. The tooltip hangs off a wrapper because a disabled button gets no
 *  hover of its own. */
function RosterAction({
  label,
  hint,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  hint: string;
  icon: ReactElement;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <IconButton label={label} disabled={disabled} onClick={onClick}>
          {icon}
        </IconButton>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{hint}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Settings → Connected agents: every agent outside Dispatch that registered
 * through `dispatch mcp`, with approve (while pending), mute and revoke.
 * Anyone can read the roster; changing it needs the decide tier, below which
 * the actions stay visible but disabled with the reason.
 */
export function AgentRosterSection({ data }: AgentRosterSectionProps) {
  const { client, port } = data;
  const { canDecide, decideReason } = useSettingsAccess();
  const queryClient = useQueryClient();
  const rosterKey = agentRosterKey(port);
  // Addresses with a change in flight, whose row's buttons wait for it.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<AgentSummary | null>(null);

  const roster = useQuery({
    queryKey: rosterKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.listAgentRoster();
    },
    enabled: client !== null,
  });

  // Runs one roster change, writes the daemon's answer into the cached row so
  // the table moves at once, then refetches to pick up anything else.
  async function act(
    address: string,
    change: (api: ApiClient) => Promise<AgentSummary>
  ): Promise<void> {
    if (client === null) return;
    setBusy((prev) => new Set(prev).add(address));
    setError(null);
    try {
      const updated = await change(client);
      queryClient.setQueryData<{ agents: AgentSummary[] }>(rosterKey, (prev) =>
        prev === undefined
          ? prev
          : {
              agents: prev.agents.map((a) =>
                a.address === updated.address ? updated : a
              ),
            }
      );
      await queryClient.invalidateQueries({ queryKey: rosterKey });
    } catch (err) {
      setError(
        isInsufficientTier(err)
          ? decideReason
          : err instanceof Error
            ? err.message
            : String(err)
      );
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(address);
        return next;
      });
    }
  }

  const agents = sortRoster(roster.data?.agents ?? []);
  const byAddress = new Map(agents.map((a) => [a.address, a]));

  const renderCell = (
    row: { id: string },
    column: RecordsColumn
  ): ReactElement | null | undefined => {
    const agent = byAddress.get(row.id);
    if (agent === undefined) return undefined;
    switch (column.key) {
      case 'client':
        return (
          <span className="font-book text-muted-foreground ml-1.5">
            {agent.client}
          </span>
        );
      case 'status': {
        const pill = STATUS_PILL[agent.status];
        return (
          <span className="flex items-center justify-end gap-1.5">
            {agent.muted && (
              <Pill>
                <BellOff aria-hidden />
                Muted
              </Pill>
            )}
            <LabelPill color={pill.color}>{pill.label}</LabelPill>
          </span>
        );
      }
      case 'approvedBy': {
        // An empty slot of the avatar's size keeps the columns aligned.
        if (agent.approvedBy === null) {
          return <span aria-hidden className="size-[18px]" />;
        }
        const who = handleOf(agent.approvedBy);
        return (
          <InitialsAvatar
            name={who}
            aria-label={`Approved by ${who}`}
            title={`Approved by ${who}`}
          />
        );
      }
      case 'actions':
        return rosterRowActions(agent);
      default:
        return undefined;
    }
  };

  // The row's buttons, right-aligned in a fixed-width cell so mute and revoke
  // line up down the table whether or not approve is there.
  function rosterRowActions(agent: AgentSummary): ReactElement {
    const offered = rosterActions(agent);
    const disabled = !canDecide || busy.has(agent.address);
    const hint = (label: string) => (canDecide ? label : decideReason);
    return (
      <span className="flex w-[92px] items-center justify-end gap-0.5">
        {offered.approve && (
          <RosterAction
            label={`Approve ${agent.address}`}
            hint={hint('Approve')}
            icon={<Check aria-hidden />}
            disabled={disabled}
            onClick={() =>
              void act(agent.address, (api) => api.approveAgent(agent.address))
            }
          />
        )}
        {offered.mute && (
          <RosterAction
            label={`${agent.muted ? 'Unmute' : 'Mute'} ${agent.address}`}
            hint={hint(agent.muted ? 'Unmute' : 'Mute')}
            icon={agent.muted ? <Bell aria-hidden /> : <BellOff aria-hidden />}
            disabled={disabled}
            onClick={() =>
              void act(agent.address, (api) =>
                api.muteAgent(agent.address, !agent.muted)
              )
            }
          />
        )}
        {offered.revoke && (
          <RosterAction
            label={`Revoke ${agent.address}`}
            hint={hint('Revoke')}
            icon={<Ban aria-hidden />}
            disabled={disabled}
            onClick={() => setConfirming(agent)}
          />
        )}
      </span>
    );
  }

  const searchText = agents
    .map((a) => `${a.address} ${a.client} ${STATUS_PILL[a.status].label}`)
    .join(' ');

  return (
    <>
      <SettingsGroup
        title="Agents"
        hint="A new agent waits as pending until someone approves it. A muted agent's messages stay readable but never interrupt anyone."
        keywords="roster connected external mcp approve mute revoke"
      >
        {roster.isError ? (
          <SettingsRow
            title="Couldn't load agents"
            subtitle={
              roster.error instanceof Error
                ? roster.error.message
                : String(roster.error)
            }
          />
        ) : roster.data === undefined ? (
          <SettingsRow title="Loading agents…" />
        ) : agents.length === 0 ? (
          <SettingsRow
            title="No agents yet"
            subtitle={
              <>
                An agent outside Dispatch shows up here once it connects with{' '}
                <code className="font-mono">dispatch mcp</code>.
              </>
            }
          />
        ) : (
          <SettingsSearchable text={searchText}>
            <div className="p-1">
              <RecordsTable
                columns={COLUMNS}
                rows={agents.map((a) => ({
                  id: a.address,
                  cells: { address: a.address, createdAt: a.createdAt },
                }))}
                sort={null}
                renderCell={renderCell}
              />
            </div>
          </SettingsSearchable>
        )}
        {error !== null && (
          <p
            role="alert"
            className="text-state-failed font-book px-3 pb-2.5 text-[12px]"
          >
            {error}
          </p>
        )}
      </SettingsGroup>

      {confirming !== null && (
        <AlertDialog open onOpenChange={(open) => !open && setConfirming(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Revoke {confirming.address}?</AlertDialogTitle>
              <AlertDialogDescription>
                Its token stops working at once. Messages it already sent stay
                readable. To come back it has to register again, and someone has
                to approve it.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel variant="ghost">Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  const { address } = confirming;
                  void act(address, (api) => api.revokeAgent(address));
                }}
              >
                Revoke
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
