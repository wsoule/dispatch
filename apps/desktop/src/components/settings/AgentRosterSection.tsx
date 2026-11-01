import type { AgentStatus, AgentSummary, ApiClient } from '@dispatch/client';
import type { ChipTone } from '@dispatch/ui';
import {
  Button,
  Chip,
  ConfirmDialog,
  InitialsAvatar,
  Tooltip,
} from '@dispatch/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Bell, BellOff, Check } from 'lucide-react';
import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import {
  agentRosterKey,
  handleOf,
  ownerOverseer,
  rosterActions,
  sortRoster,
} from '../../lib/agentRoster';
import { isInsufficientTier } from '../../lib/daemonAuth';
import { formatShortDate } from '../../lib/taskDates';
import { useSettingsAccess } from './access';
import styles from './AgentRosterSection.module.css';
import { SettingsSearchable } from './search';
import shared from './settings.module.css';
import { SettingsGroup, SettingsRow } from './SettingsGroup';

interface AgentRosterSectionProps {
  data: DispatchProjectData;
}

const STATUS_PILL: Record<AgentStatus, { label: string; tone: ChipTone }> = {
  pending: { label: 'Pending', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  revoked: { label: 'Revoked', tone: 'danger' },
};

const ICON = { size: 14, strokeWidth: 1.8, 'aria-hidden': true } as const;

function muteLabel(agent: AgentSummary): string {
  return `${agent.muted ? 'Unmute' : 'Mute'} ${agent.address}`;
}

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
    <Tooltip content={hint}>
      <Button
        variant="quiet"
        size="sm"
        icon={icon}
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
      />
    </Tooltip>
  );
}

/**
 * Settings → Connected agents: every agent outside Dispatch that registered
 * through `dispatch mcp`, with approve (while pending), mute and revoke.
 * Anyone can read the roster; changing it needs the decide tier, below which
 * the actions stay visible but disabled, with the reason written above them.
 */
export function AgentRosterSection({ data }: AgentRosterSectionProps) {
  const { client, port } = data;
  const { canDecide, decideReason } = useSettingsAccess();
  const overseer = ownerOverseer(data.me, data.ownerCredential);
  const queryClient = useQueryClient();
  const rosterKey = agentRosterKey(port);
  // Addresses with a change in flight, whose row's buttons wait for it.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<AgentSummary | null>(null);
  // After a change, focus goes to the row's mute button, or to the table (label null)
  // once the row offers nothing, so it never falls to the page with the pressed button.
  const [refocus, setRefocus] = useState<{
    agent: AgentSummary;
    label: string | null;
    /** What had focus when the change started. */
    from: Element | null;
  } | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

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
    const from = document.activeElement;
    setBusy((prev) => new Set(prev).add(address));
    setError(null);
    try {
      const updated = await change(client);
      setRefocus({
        agent: updated,
        label: rosterActions(updated, overseer).mute
          ? muteLabel(updated)
          : null,
        from,
      });
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

  // Waits until the row shows the change (a re-sort moves it, which drops focus)
  // and the target is enabled, then refocuses unless the user moved focus meanwhile.
  useEffect(() => {
    const table = tableRef.current;
    if (refocus === null || table === null) return;
    const shown = roster.data?.agents.find(
      (a) => a.address === refocus.agent.address
    );
    if (
      shown?.status !== refocus.agent.status ||
      shown.muted !== refocus.agent.muted
    ) {
      return;
    }
    const target =
      refocus.label === null
        ? table
        : Array.from(table.querySelectorAll('button')).find(
            (button) =>
              button.getAttribute('aria-label') === refocus.label &&
              !button.disabled
          );
    if (target === undefined) return;
    setRefocus(null);
    const active = document.activeElement;
    if (
      active === null ||
      active === document.body ||
      !active.isConnected ||
      active === refocus.from
    ) {
      target.focus();
    }
  }, [refocus, roster.data, busy]);

  const agents = sortRoster(roster.data?.agents ?? []);
  // One roster row: address and client, status, approver, actions and the date added.
  function rosterRow(agent: AgentSummary): ReactElement {
    const pill = STATUS_PILL[agent.status];
    const who = agent.approvedBy === null ? null : handleOf(agent.approvedBy);
    return (
      <div key={agent.address} role="row" className={styles.row}>
        <span role="cell" className={styles.title} data-roster-title="">
          <span className={styles.address}>{agent.address}</span>
          <span className={styles.client}>
            {agent.client}
            {typeof agent.remote === 'string' && (
              <Chip>{`remote: ${agent.remote}`}</Chip>
            )}
          </span>
        </span>
        <span role="cell" className={styles.status}>
          {agent.muted && (
            <Chip tone="muted">
              <BellOff size={12} strokeWidth={1.8} aria-hidden />
              Muted
            </Chip>
          )}
          <Chip tone={pill.tone}>{pill.label}</Chip>
        </span>
        <span role="cell" className={styles.approver}>
          {/* An empty slot of the avatar's size keeps the columns aligned. */}
          {who !== null && (
            <span
              role="img"
              aria-label={`Approved by ${who}`}
              title={`Approved by ${who}`}
            >
              <InitialsAvatar name={who} />
            </span>
          )}
        </span>
        <span role="cell">{rosterRowActions(agent)}</span>
        <span role="cell" className={styles.date}>
          {formatShortDate(agent.createdAt)}
        </span>
      </div>
    );
  }

  // The row's buttons, right-aligned in a fixed-width cell so mute and revoke
  // line up down the table whether or not approve is there.
  function rosterRowActions(agent: AgentSummary): ReactElement {
    // A teammate's agent is approved or revoked only on its own machine.
    const remote = typeof agent.remote === 'string';
    const base = rosterActions(agent, overseer);
    const offered = remote ? { ...base, approve: false, revoke: false } : base;
    const disabled = !canDecide || busy.has(agent.address);
    const hint = (label: string) => (canDecide ? label : decideReason);
    return (
      <span className={styles.actions}>
        {offered.approve && (
          <RosterAction
            label={`Approve ${agent.address}`}
            hint={hint('Approve')}
            icon={<Check {...ICON} />}
            disabled={disabled}
            onClick={() =>
              void act(agent.address, (api) => api.approveAgent(agent.address))
            }
          />
        )}
        {offered.mute && (
          <RosterAction
            label={muteLabel(agent)}
            hint={hint(agent.muted ? 'Unmute' : 'Mute')}
            icon={agent.muted ? <Bell {...ICON} /> : <BellOff {...ICON} />}
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
            icon={<Ban {...ICON} />}
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
        requires="none"
      >
        {!canDecide && (
          <SettingsRow
            title="Approving, muting and revoking"
            subtitle={decideReason}
            locked={decideReason}
          />
        )}
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
                <code className="mono">dispatch mcp</code>.
              </>
            }
          />
        ) : (
          <SettingsSearchable text={searchText}>
            <div
              ref={tableRef}
              role="group"
              aria-label="Agents"
              tabIndex={-1}
              className={styles.roster}
            >
              <div role="table" aria-label="Connected agents">
                {agents.map(rosterRow)}
              </div>
            </div>
          </SettingsSearchable>
        )}
        {error !== null && (
          <p role="alert" className={`${shared.error} ${styles.error}`}>
            {error}
          </p>
        )}
      </SettingsGroup>

      <ConfirmDialog
        open={confirming !== null}
        title={`Revoke ${confirming?.address ?? ''}?`}
        description="Its token stops working at once. Messages it already sent stay readable. To come back it has to register again, and someone has to approve it."
        confirmLabel="Revoke"
        destructive
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming === null) return;
          const { address } = confirming;
          setConfirming(null);
          void act(address, (api) => api.revokeAgent(address));
        }}
      />
    </>
  );
}
