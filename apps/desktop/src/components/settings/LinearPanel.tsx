import type {
  LinearSyncSummary,
  LinearViewer,
  LinearWorkflowState,
} from '@dispatch/client';
import { CheckCircle2, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { formatRelativeTimeFromIso } from '../../lib/format';
import {
  describeFetchFailure,
  formatSyncCounts,
  isLinearConfigured,
  linearKeySourceNote,
  resolveMappedStateId,
  statusMapCompleteness,
} from '../../lib/linearSettings';
import { useSettingsAccess } from './access';
import { SettingsSwitch } from './fields';
import { SettingsGroup, SettingsHint, SettingsRow } from './SettingsGroup';
import { cn } from '@/lib/utils';
import { PillButton } from '@/ui/ai/pill';
import { Button } from '@/ui/button';
import { PanelRow } from '@/ui/chrome';
import { Input } from '@/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

const LINEAR_DIRECTIONS: { value: 'both' | 'pull' | 'push'; label: string }[] =
  [
    { value: 'both', label: 'Pull and push' },
    { value: 'pull', label: 'Pull only (Linear → Dispatch)' },
    { value: 'push', label: 'Push only (Dispatch → Linear)' },
  ];

// Free-typed while focused, snapped back to the saved value on blur if it isn't a valid
// interval (mirrors AgentsSection's concurrency input).
function LinearIntervalRow({
  value,
  onSave,
}: {
  value: number;
  onSave: (intervalSec: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <SettingsRow
      title="Check for changes every"
      subtitle="At least 30 seconds."
      keywords="poll interval"
      htmlFor="linear-poll-interval"
      control={
        <Input
          id="linear-poll-interval"
          aria-label="Poll interval"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const n = Number(draft);
            if (Number.isInteger(n) && n >= 30 && n !== value) {
              onSave(n);
            } else {
              setDraft(String(value));
            }
          }}
          inputMode="numeric"
          className="w-20 text-right tabular-nums"
        />
      }
    />
  );
}

// One status-map row: a dispatch status and a select of the team's workflow states, falling
// back to a "Not mapped" placeholder for a missing or stale (post-team-change) entry.
function LinearStatusMapRow({
  status,
  value,
  states,
  onChange,
}: {
  status: string;
  value: string | undefined;
  states: LinearWorkflowState[];
  onChange: (state: LinearWorkflowState) => void;
}) {
  const selectedId = resolveMappedStateId(value, states);
  return (
    <SettingsRow
      title={status}
      control={
        <Select
          value={selectedId}
          onValueChange={(id) => {
            const state = states.find((s) => s.id === id);
            if (state !== undefined) onChange(state);
          }}
        >
          <SelectTrigger aria-label={`${status} maps to`} className="w-[180px]">
            <SelectValue placeholder="Not mapped" />
          </SelectTrigger>
          <SelectContent>
            {states.map((state) => (
              <SelectItem key={state.id} value={state.id}>
                {state.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  );
}

/** A failed teams/states fetch, rendered above the control it starved — the actionable reason
 *  plus a retry, instead of letting the picker sit there empty with no explanation. */
function FetchFailureRow({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <PanelRow className="flex-nowrap gap-3">
      <span className="text-state-failed min-w-0 flex-1 text-[12px]">
        {describeFetchFailure(error)}
      </span>
      <PillButton onClick={onRetry}>Retry</PillButton>
    </PanelRow>
  );
}

/** Linear sync settings: connect a write-only API key, pick the team/direction/interval, map
 *  statuses to workflow states, and run a sync on demand. */
export function LinearPanel({ data }: { data: DispatchProjectData }) {
  const { linearStatus, linearTeams, linearStates, config } = data;
  const [apiKey, setApiKey] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  // Populated only by a fresh connect response — the status endpoint deliberately reports no
  // identity, just where a key was found, so this is the one place a viewer name can come from.
  const [viewer, setViewer] = useState<LinearViewer | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<LinearSyncSummary | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<LinearSyncSummary | null>(
    null
  );
  // The key decides whose Linear account the board is sent to, so the daemon
  // lets only the owner set or remove it; import and sync just use it.
  const { canOperate } = useSettingsAccess();

  if (config === null || linearStatus === null) return null;

  async function connect() {
    const key = apiKey.trim();
    if (key === '') return;
    setConnecting(true);
    setConnectError(null);
    try {
      const result = await data.handleConnectLinear(key);
      setViewer(result.viewer);
      setApiKey('');
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect() {
    setDisconnecting(true);
    setDisconnectError(null);
    try {
      await data.handleDisconnectLinear();
      setViewer(null);
      setSyncResult(null);
    } catch (err) {
      setDisconnectError(err instanceof Error ? err.message : String(err));
    } finally {
      setDisconnecting(false);
    }
  }

  async function importFromLinear() {
    setImporting(true);
    setImportError(null);
    try {
      setImportResult(await data.handleImportLinear());
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }

  async function sync() {
    setSyncing(true);
    setSyncError(null);
    try {
      setSyncResult(await data.handleSyncLinear());
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }

  const configured = isLinearConfigured(linearStatus);
  const teamChosen =
    config.linear.teamId !== null && config.linear.teamId.trim() !== '';
  const completeness = statusMapCompleteness(
    config.statuses,
    config.linear.statusMap,
    linearStates
  );
  // Whichever summary is freshest: this session's own "Sync now" result, or the last pass the
  // daemon ran (on a timer, on a task edit, or before this window opened).
  const summary = syncResult ?? linearStatus.lastSummary;
  // `lastError` is disk-persisted and outlives a daemon restart, unlike `summary` (in-memory,
  // reset on restart) — shown on its own unless the current summary already carries it.
  const lastErrorInSummary =
    summary !== null &&
    linearStatus.lastError !== null &&
    summary.errors.includes(linearStatus.lastError);
  // The input stays available while an env or shared key is resolving — that is the only way
  // to give this project a key of its own. It disappears once the project has one.
  const keyNote = linearKeySourceNote(linearStatus.keySource);

  return (
    <>
      {/* Connect, disconnect, import and sync use Linear's own routes, not
          config, so the group stays open when config is read-only. Import
          and sync are any teammate's; the key rows lock to the owner. */}
      <SettingsGroup
        title="Connection"
        hint="Your API key is stored on this machine, never in the repo."
        keywords="linear api key"
        requires="none"
      >
        {linearStatus.keySource !== 'project' && (
          <SettingsRow
            title="API key"
            subtitle={keyNote}
            htmlFor="linear-api-key"
            stacked
            locked={!canOperate}
            control={
              <>
                <Input
                  id="linear-api-key"
                  type="password"
                  autoComplete="off"
                  placeholder="Linear API key"
                  value={apiKey}
                  disabled={!canOperate}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="max-w-xs"
                />
                <Button
                  disabled={!canOperate || connecting || apiKey.trim() === ''}
                  onClick={() => void connect()}
                >
                  {connecting ? 'Connecting…' : 'Connect'}
                </Button>
              </>
            }
          >
            {connectError !== null && (
              <span className="text-state-failed text-[12px]">
                {connectError}
              </span>
            )}
          </SettingsRow>
        )}

        {linearStatus.connected && (
          <SettingsRow
            title={
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="text-state-review size-3.5 shrink-0" />
                Connected{viewer !== null ? ` as ${viewer.name}` : ''}
              </span>
            }
            locked={linearStatus.keySource === 'project' && !canOperate}
            control={
              linearStatus.keySource === 'project' ? (
                <PillButton
                  disabled={!canOperate || disconnecting}
                  onClick={() => void disconnect()}
                >
                  {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                </PillButton>
              ) : undefined
            }
          >
            {disconnectError !== null && (
              <span className="text-state-failed text-[12px]">
                {disconnectError}
              </span>
            )}
          </SettingsRow>
        )}
      </SettingsGroup>

      {linearStatus.connected && (
        <SettingsGroup
          title="Sync settings"
          hint="Issues in the chosen team and tasks here stay in step, statuses included."
          keywords="linear team direction"
        >
          <SettingsRow
            title="Sync this project with Linear"
            subtitle={teamChosen ? undefined : 'Choose a team first.'}
            htmlFor="linear-enabled"
            control={
              <SettingsSwitch
                id="linear-enabled"
                checked={config.linear.enabled}
                disabled={!configured}
                onCheckedChange={(checked) =>
                  void data.handleUpdateConfig({
                    linear: { enabled: checked },
                  })
                }
              />
            }
          />

          {data.linearTeamsError !== null && (
            <FetchFailureRow
              error={data.linearTeamsError}
              onRetry={() => data.refetchLinearTeams()}
            />
          )}

          <SettingsRow
            title="Team"
            control={
              <Select
                value={config.linear.teamId ?? ''}
                onValueChange={(teamId) =>
                  void data.handleUpdateConfig({ linear: { teamId } })
                }
              >
                <SelectTrigger aria-label="Team" className="w-[200px]">
                  <SelectValue placeholder="Choose a team" />
                </SelectTrigger>
                <SelectContent>
                  {linearTeams.map((team) => (
                    <SelectItem key={team.id} value={team.id}>
                      {team.name} ({team.key})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />

          <SettingsRow
            title="Direction"
            control={
              <Select
                value={config.linear.direction}
                onValueChange={(direction) =>
                  void data.handleUpdateConfig({
                    linear: {
                      direction: direction as 'both' | 'pull' | 'push',
                    },
                  })
                }
              >
                <SelectTrigger aria-label="Direction" className="w-[200px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LINEAR_DIRECTIONS.map((d) => (
                    <SelectItem key={d.value} value={d.value}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />

          <LinearIntervalRow
            value={config.linear.intervalSec}
            onSave={(intervalSec) =>
              void data.handleUpdateConfig({ linear: { intervalSec } })
            }
          />

          <PanelRow>
            <SettingsHint>
              Labels come in from Linear but don&rsquo;t go back out yet, so
              change labels in Linear for now.
            </SettingsHint>
          </PanelRow>
        </SettingsGroup>
      )}

      {linearStatus.connected && teamChosen && (
        <SettingsGroup
          title="Status mapping"
          hint={`Which Linear state each column matches. ${String(completeness.mapped)} of ${String(completeness.total)} mapped.`}
          keywords="workflow states columns"
        >
          {data.linearStatesError !== null && (
            <FetchFailureRow
              error={data.linearStatesError}
              onRetry={() => data.refetchLinearStates()}
            />
          )}
          {config.statuses.map((status) => (
            <LinearStatusMapRow
              key={status}
              status={status}
              value={config.linear.statusMap[status]}
              states={linearStates}
              onChange={(state) =>
                void data.handleUpdateConfig({
                  linear: { statusMap: { [status]: state.name } },
                })
              }
            />
          ))}
        </SettingsGroup>
      )}

      {linearStatus.connected && (
        <SettingsGroup title="Sync" keywords="linear import" requires="none">
          <SettingsRow
            title="Import from Linear"
            subtitle="Sync only carries changes to linked tasks. Import brings in every issue in the team that isn't here yet."
            control={
              <PillButton
                disabled={importing || !configured}
                onClick={() => void importFromLinear()}
              >
                {importing ? 'Importing…' : 'Import from Linear'}
              </PillButton>
            }
          >
            {importResult !== null && (
              <SettingsHint>{formatSyncCounts(importResult)}</SettingsHint>
            )}
            {importError !== null && (
              <span className="text-state-failed text-[12px]">
                {importError}
              </span>
            )}
          </SettingsRow>

          <SettingsRow
            title="Sync now"
            subtitle={
              linearStatus.lastSyncAt !== null
                ? `Last sync ${formatRelativeTimeFromIso(linearStatus.lastSyncAt)}.`
                : 'Not synced yet.'
            }
            control={
              <PillButton
                disabled={syncing || linearStatus.syncing || !configured}
                onClick={() => void sync()}
              >
                <RefreshCw
                  className={cn(
                    'size-3.5',
                    (syncing || linearStatus.syncing) &&
                      'animate-spin motion-reduce:animate-none'
                  )}
                />
                {syncing || linearStatus.syncing ? 'Syncing…' : 'Sync now'}
              </PillButton>
            }
          >
            {linearStatus.lastError !== null && !lastErrorInSummary && (
              <span className="text-state-failed text-[12px]">
                {linearStatus.lastError}
              </span>
            )}
            {summary !== null && (
              <div className="flex flex-col gap-1">
                <SettingsHint>{formatSyncCounts(summary)}</SettingsHint>
                {summary.errors.map((message, i) => (
                  <span
                    key={`${message}-${String(i)}`}
                    className="text-state-failed text-[12px]"
                  >
                    {message}
                  </span>
                ))}
                {summary.rateLimited && (
                  <span className="text-state-failed text-[12px]">
                    Linear rate-limited this pass — it will retry on its own.
                  </span>
                )}
              </div>
            )}
            {syncError !== null && (
              <span className="text-state-failed text-[12px]">{syncError}</span>
            )}
          </SettingsRow>
        </SettingsGroup>
      )}
    </>
  );
}
