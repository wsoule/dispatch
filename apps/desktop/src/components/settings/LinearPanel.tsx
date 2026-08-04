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
import { cn } from '@/lib/utils';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { HintText, MetaText, Panel, PanelHeader, PanelRow } from '@/ui/chrome';
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
    { value: 'pull', label: 'Pull only — Linear to Dispatch' },
    { value: 'push', label: 'Push only — Dispatch to Linear' },
  ];

// Free-typed while focused, snapped back to the saved value on blur if it isn't a valid
// interval (mirrors ProjectSettingsSection's concurrency input).
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
    <PanelRow>
      <label className="flex items-center gap-3">
        <span className="w-40 flex-shrink-0 text-[13px]">Poll interval</span>
        <Input
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
          className="w-20 font-mono text-[12.5px]"
        />
      </label>
      <MetaText>seconds, minimum 30</MetaText>
    </PanelRow>
  );
}

// One status-map row: a dispatch status and a `<select>` of the team's workflow states, falling
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
    <div className="flex items-center gap-3 py-1">
      <Badge
        variant="outline"
        className="w-32 flex-shrink-0 justify-start truncate"
      >
        {status}
      </Badge>
      <Select
        value={selectedId}
        onValueChange={(id) => {
          const state = states.find((s) => s.id === id);
          if (state !== undefined) onChange(state);
        }}
      >
        <SelectTrigger size="sm" className="w-[200px] text-[12px]">
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
    </div>
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
    <PanelRow className="flex-col items-stretch gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-state-failed text-[12px]">
          {describeFetchFailure(error)}
        </span>
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Retry
        </Button>
      </div>
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
    <Panel>
      <PanelHeader>Linear</PanelHeader>

      {linearStatus.keySource !== 'project' && (
        <PanelRow className="flex-col items-stretch gap-2">
          <HintText>{keyNote}</HintText>
          <div className="flex items-center gap-2">
            <Input
              type="password"
              autoComplete="off"
              placeholder="Linear API key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="max-w-xs font-mono text-[12.5px]"
            />
            <Button
              size="sm"
              disabled={connecting || apiKey.trim() === ''}
              onClick={() => void connect()}
            >
              {connecting ? 'Connecting…' : 'Connect'}
            </Button>
          </div>
          {connectError !== null && (
            <span className="text-state-failed text-[12px]">
              {connectError}
            </span>
          )}
        </PanelRow>
      )}

      {linearStatus.connected && (
        <>
          <PanelRow className="flex-col items-stretch gap-1.5">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="text-state-review size-3.5 flex-shrink-0" />
              <span className="text-[13px]">
                Connected{viewer !== null ? ` as ${viewer.name}` : ''}
              </span>
              {linearStatus.keySource === 'project' && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="ml-auto"
                  disabled={disconnecting}
                  onClick={() => void disconnect()}
                >
                  {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                </Button>
              )}
            </div>
            {disconnectError !== null && (
              <span className="text-state-failed text-[12px]">
                {disconnectError}
              </span>
            )}
          </PanelRow>

          <PanelRow>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={config.linear.enabled}
                disabled={!configured}
                onChange={(e) =>
                  void data.handleUpdateConfig({
                    linear: { enabled: e.target.checked },
                  })
                }
                className="accent-accent size-3.5"
              />
              <span className="text-[13px]">Sync this project with Linear</span>
            </label>
            {!teamChosen && <MetaText>choose a team first</MetaText>}
          </PanelRow>

          {data.linearTeamsError !== null && (
            <FetchFailureRow
              error={data.linearTeamsError}
              onRetry={() => data.refetchLinearTeams()}
            />
          )}

          <PanelRow>
            <label className="flex items-center gap-3">
              <span className="w-40 flex-shrink-0 text-[13px]">Team</span>
              <Select
                value={config.linear.teamId ?? ''}
                onValueChange={(teamId) =>
                  void data.handleUpdateConfig({ linear: { teamId } })
                }
              >
                <SelectTrigger
                  size="sm"
                  aria-label="Team"
                  className="w-[220px] text-[12px]"
                >
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
            </label>
          </PanelRow>

          <PanelRow>
            <label className="flex items-center gap-3">
              <span className="w-40 flex-shrink-0 text-[13px]">Direction</span>
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
                <SelectTrigger
                  size="sm"
                  aria-label="Direction"
                  className="w-[220px] text-[12px]"
                >
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
            </label>
          </PanelRow>

          <LinearIntervalRow
            value={config.linear.intervalSec}
            onSave={(intervalSec) =>
              void data.handleUpdateConfig({ linear: { intervalSec } })
            }
          />

          <PanelRow>
            <HintText>
              Labels sync in from Linear, but a label you add or remove here
              does not push back out yet — edit labels on the Linear side for
              now.
            </HintText>
          </PanelRow>

          {data.linearStatesError !== null && (
            <FetchFailureRow
              error={data.linearStatesError}
              onRetry={() => data.refetchLinearStates()}
            />
          )}

          {teamChosen && (
            <PanelRow className="flex-col items-stretch gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[12px]">Status mapping</span>
                <MetaText>
                  {completeness.mapped} of {completeness.total} mapped
                </MetaText>
              </div>
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
            </PanelRow>
          )}

          <PanelRow className="flex-col items-stretch gap-1.5">
            <HintText>
              Sync only moves what changes after a task is linked — it never
              bulk-imports the backlog on its own. Import brings down every
              issue in this team that has no matching task yet.
            </HintText>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={importing || !configured}
                onClick={() => void importFromLinear()}
              >
                {importing ? 'Importing…' : 'Import from Linear'}
              </Button>
              {importResult !== null && (
                <MetaText>{formatSyncCounts(importResult)}</MetaText>
              )}
            </div>
            {importError !== null && (
              <span className="text-state-failed text-[12px]">
                {importError}
              </span>
            )}
          </PanelRow>

          <PanelRow className="flex-col items-stretch gap-1.5">
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={syncing || linearStatus.syncing || !configured}
                onClick={() => void sync()}
              >
                <RefreshCw
                  className={cn(
                    'size-3.5',
                    (syncing || linearStatus.syncing) && 'animate-spin'
                  )}
                />
                {syncing || linearStatus.syncing ? 'Syncing…' : 'Sync now'}
              </Button>
              {linearStatus.lastSyncAt !== null && (
                <MetaText>
                  Last sync {formatRelativeTimeFromIso(linearStatus.lastSyncAt)}
                </MetaText>
              )}
            </div>
            {linearStatus.lastError !== null && !lastErrorInSummary && (
              <span className="text-state-failed text-[12px]">
                {linearStatus.lastError}
              </span>
            )}

            {summary !== null && (
              <div className="flex flex-col gap-1">
                <MetaText>{formatSyncCounts(summary)}</MetaText>
                {summary.errors.map((message, i) => (
                  <span
                    key={`${message}-${i}`}
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
          </PanelRow>
        </>
      )}
    </Panel>
  );
}
