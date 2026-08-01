import type {
  LinearSyncSummary,
  LinearViewer,
  LinearWorkflowState,
} from '@dispatch/client';
import type { DispatchConfig, ModelConfig } from '@dispatch/core';
import { MODEL_ROLES } from '@dispatch/core';
import {
  AlertCircle,
  CheckCircle2,
  FolderSearch,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { describeDaemonError } from '../components/shell/DaemonUnavailable';
import { ProjectSettingsSection } from '../components/shell/ProjectSettingsSection';
import { StatTile } from '../components/ui/StatTile';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { formatRelativeTimeFromIso } from '../lib/format';
import {
  formatSyncCounts,
  isLinearConfigured,
  resolveMappedStateId,
  statusMapCompleteness,
} from '../lib/linearSettings';
import { MODELS } from '../lib/models';
import { cn } from '@/lib/utils';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import { Separator } from '@/ui/separator';

interface SettingsViewProps {
  /** The one project this window is scoped to — just its filesystem path is needed here, so
   * this takes the same minimal `{ path, name }` shape `App.tsx` derives from
   * `currentProjectRoot()`, not the full Relay `ProjectSummary` (id/lang/stack/etc.) that
   * only makes sense for a row out of Relay's own multi-project database. */
  activeProject: { path: string; name: string } | null;
  data: DispatchProjectData;
}

/** Daemon status renders as a small colored dot rather than a text pill: gray while
 * starting, indigo once connected, red if the sidecar never came up. */
function daemonDotClass(data: DispatchProjectData): string {
  if (data.portLoading) return 'bg-muted-foreground/40';
  return data.client !== null ? 'bg-primary' : 'bg-state-failed';
}

function daemonStatusLabel(data: DispatchProjectData): string {
  if (data.portLoading) return 'starting';
  return data.client !== null ? 'running' : 'not running';
}

// One row per config.models role, mirroring the doc comments on ModelConfig in
// packages/core/src/config.ts so picking a cheap model for a cheap role doesn't require reading
// the config schema.
const ROLE_INFO: Record<keyof ModelConfig, { label: string; hint: string }> = {
  execute: { label: 'Coding runs', hint: 'The agent that edits the repo.' },
  plan: { label: 'Planning', hint: 'Multi-turn planning conversations.' },
  draft: {
    label: 'Task drafting',
    hint: 'One-shot natural-language task drafting.',
  },
  enrich: {
    label: 'Enrichment',
    hint: 'Filling in description / acceptance criteria for a task or inbox item.',
  },
  cluster: {
    label: 'Inbox clustering',
    hint: 'Grouping inbox captures into suggested epics.',
  },
  summarize: {
    label: 'Summaries',
    hint: 'Short mechanical text: titles, summaries, commit messages.',
  },
};

// The models section: one dropdown per agent role in `config.models`, persisted straight to
// `.dispatch/config.yml` via handleUpdateConfig — so the CLI and daemon see the same choice, not
// just this browser. `execute` (coding runs) is still overridable per-dispatch and per-device
// (localStorage, see lib/models.ts's resolveExecuteModel) — this is what that override layers
// on top of.
function ModelRolesSection({
  config,
  onSave,
}: {
  config: DispatchConfig;
  onSave: DispatchProjectData['handleUpdateConfig'];
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        Models
      </h2>
      <div className="flex flex-col gap-0.5">
        {MODEL_ROLES.map((role) => {
          const info = ROLE_INFO[role];
          return (
            <div
              key={role}
              className="border-border flex items-center gap-3 border-b py-2 last:border-b-0"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-foreground text-[13px] font-medium">
                  {info.label}
                </span>
                <span className="text-muted-foreground text-[11px]">
                  {info.hint}
                </span>
              </div>
              <Select
                value={config.models[role]}
                onValueChange={(id) => void onSave({ models: { [role]: id } })}
              >
                <SelectTrigger
                  size="sm"
                  aria-label={`${info.label} model`}
                  className="w-[168px] shrink-0 text-[12px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODELS.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>
    </section>
  );
}

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
    <div className="border-border flex items-center gap-3 border-b py-2">
      <span className="text-muted-foreground w-40 flex-shrink-0 text-[13px]">
        Poll interval
      </span>
      <input
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
        className="shadow-hairline w-20 rounded-md px-2 py-1.5 font-mono text-[12.5px] outline-none"
      />
      <span className="text-muted-foreground text-[11px]">
        seconds, minimum 30
      </span>
    </div>
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

/** Linear sync settings: connect a write-only API key, pick the team/direction/interval, map
 *  statuses to workflow states, and run a sync on demand. */
function LinearSection({ data }: { data: DispatchProjectData }) {
  const { linearStatus, linearTeams, linearStates, config } = data;
  const [apiKey, setApiKey] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  // Populated only by a fresh connect response — the status endpoint deliberately reports no
  // identity, just where a key was found, so this is the one place a viewer name can come from.
  const [viewer, setViewer] = useState<LinearViewer | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<LinearSyncSummary | null>(null);

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
    try {
      await data.handleDisconnectLinear();
      setViewer(null);
      setSyncResult(null);
    } finally {
      setDisconnecting(false);
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

  return (
    <section className="flex flex-col gap-3">
      <h2 className="dense-label">Linear</h2>

      {!linearStatus.connected ? (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-[12px]">
            Connect a Linear API key to pull issues in and push task changes
            back out. The key is sent once and never shown again — only whether
            a connection exists.
          </p>
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
            <span className="text-destructive text-[12px]">{connectError}</span>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="text-state-review size-3.5 flex-shrink-0" />
            <span className="text-[13px]">
              Connected{viewer !== null ? ` as ${viewer.name}` : ''}
            </span>
            <Button
              size="sm"
              variant="secondary"
              className="ml-auto"
              disabled={disconnecting}
              onClick={() => void disconnect()}
            >
              {disconnecting ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </div>

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
            {!teamChosen && (
              <span className="dense-meta">choose a team first</span>
            )}
          </label>

          <div className="border-border flex items-center gap-3 border-b py-2">
            <span className="text-muted-foreground w-40 flex-shrink-0 text-[13px]">
              Team
            </span>
            <Select
              value={config.linear.teamId ?? ''}
              onValueChange={(teamId) =>
                void data.handleUpdateConfig({ linear: { teamId } })
              }
            >
              <SelectTrigger size="sm" className="w-[220px] text-[12px]">
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
          </div>

          <div className="border-border flex items-center gap-3 border-b py-2">
            <span className="text-muted-foreground w-40 flex-shrink-0 text-[13px]">
              Direction
            </span>
            <Select
              value={config.linear.direction}
              onValueChange={(direction) =>
                void data.handleUpdateConfig({
                  linear: { direction: direction as 'both' | 'pull' | 'push' },
                })
              }
            >
              <SelectTrigger size="sm" className="w-[220px] text-[12px]">
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
          </div>

          <LinearIntervalRow
            value={config.linear.intervalSec}
            onSave={(intervalSec) =>
              void data.handleUpdateConfig({ linear: { intervalSec } })
            }
          />

          <p className="text-muted-foreground text-[12px]">
            Labels sync in from Linear, but a label you add or remove here does
            not push back out yet — edit labels on the Linear side for now.
          </p>

          {teamChosen && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground text-[12px]">
                  Status mapping
                </span>
                <span className="dense-meta">
                  {completeness.mapped} of {completeness.total} mapped
                </span>
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
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
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
              <span className="dense-meta">
                Last sync {formatRelativeTimeFromIso(linearStatus.lastSyncAt)}
              </span>
            )}
          </div>

          {summary !== null && (
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground text-[12px]">
                {formatSyncCounts(summary)}
              </span>
              {summary.errors.map((message, i) => (
                <span
                  key={`${message}-${i}`}
                  className="text-destructive text-[12px]"
                >
                  {message}
                </span>
              ))}
              {summary.rateLimited && (
                <span className="text-destructive text-[12px]">
                  Linear rate-limited this pass — it will retry on its own.
                </span>
              )}
            </div>
          )}
          {syncError !== null && (
            <span className="text-destructive text-[12px]">{syncError}</span>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Settings for the active project: the writable half (verify command, auto-commit, epic
 * concurrency, permission posture, per-role models — all persisted to `.dispatch/config.yml` in
 * the repo, so the CLI and daemon see the same values), and read-only daemon status. The daemon
 * stays read-only deliberately: the sidecar is process-managed, not something this view should
 * be able to kill or restart. No placeholder sections — only what exists renders.
 */
export function SettingsView({ activeProject, data }: SettingsViewProps) {
  if (activeProject === null) {
    return (
      <div className="flex max-w-2xl flex-col gap-5">
        <h1 className="text-foreground text-[15px] font-medium">Settings</h1>
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <FolderSearch className="text-muted-foreground size-5" />
          <p className="text-muted-foreground max-w-sm text-[13px]">
            Select a project from the sidebar to see its daemon status and
            tracker config.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <h1 className="text-foreground text-[15px] font-medium">Settings</h1>

      <ProjectSettingsSection
        config={data.config}
        onSave={data.handleUpdateConfig}
      />

      {data.config !== null && (
        <>
          <Separator />
          <ModelRolesSection
            config={data.config}
            onSave={data.handleUpdateConfig}
          />
        </>
      )}

      {data.config !== null && (
        <>
          <Separator />
          <LinearSection data={data} />
        </>
      )}

      <Separator />

      <section className="flex flex-col gap-3">
        <h2 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          Daemon
        </h2>
        <div className="flex items-center gap-2">
          <span
            className={`size-1.5 flex-shrink-0 rounded-full ${daemonDotClass(data)}`}
            aria-hidden="true"
          />
          <span className="text-foreground text-[13px]">
            {daemonStatusLabel(data)}
          </span>
          <span className="text-muted-foreground font-mono text-[11px]">
            {activeProject.path}
          </span>
        </div>
        {data.portError && (
          <div className="flex flex-col gap-1.5">
            <p className="text-destructive flex items-center gap-1.5 text-[13px]">
              <AlertCircle className="size-3.5 flex-shrink-0" />
              Couldn&rsquo;t start dispatchd
            </p>
            {describeDaemonError(data.portErrorDetail) !== null && (
              <pre className="text-muted-foreground bg-secondary/50 max-h-48 overflow-auto rounded-md p-3 text-left font-mono text-[11px] whitespace-pre-wrap">
                {describeDaemonError(data.portErrorDetail)}
              </pre>
            )}
          </div>
        )}
        {data.health !== undefined && (
          <div className="grid grid-cols-3 gap-3">
            <StatTile
              value={data.health.pr ? 'Yes' : 'No'}
              label="PR capability"
            />
            <StatTile value={data.tasks.length} label="Tasks tracked" />
            <StatTile value={data.runs.length} label="Runs recorded" />
          </div>
        )}
      </section>

      {data.config !== null && (
        <>
          <Separator />
          <section className="flex flex-col gap-1">
            <h2 className="text-muted-foreground mb-2 text-[11px] font-medium tracking-wide uppercase">
              Tracker config
            </h2>
            <div className="border-border flex items-center gap-3 border-b py-2">
              <span className="text-muted-foreground w-48 flex-shrink-0 text-[13px]">
                Statuses
              </span>
              <div className="flex flex-wrap gap-1">
                {data.config.statuses.map((status) => (
                  <Badge key={status} variant="outline">
                    {status}
                  </Badge>
                ))}
              </div>
            </div>
            <div className="border-border flex items-center gap-3 border-b py-2">
              <span className="text-muted-foreground w-48 flex-shrink-0 text-[13px]">
                Auto-commit
              </span>
              <span className="text-foreground font-mono text-[13px]">
                {data.config.autoCommit ? 'enabled' : 'disabled'}
              </span>
            </div>
            <div className="border-border flex items-center gap-3 border-b py-2">
              <span className="text-muted-foreground w-48 flex-shrink-0 text-[13px]">
                Max turns
              </span>
              <span className="text-foreground font-mono text-[13px]">
                {data.config.orchestrator.maxTurns}
              </span>
            </div>
            <div className="border-border flex items-center gap-3 border-b py-2">
              <span className="text-muted-foreground w-48 flex-shrink-0 text-[13px]">
                Permission mode
              </span>
              <span className="text-foreground font-mono text-[13px]">
                {data.config.orchestrator.permissionMode}
              </span>
            </div>
            <div className="border-border flex items-center gap-3 border-b py-2">
              <span className="text-muted-foreground w-48 flex-shrink-0 text-[13px]">
                Default epic concurrency
              </span>
              <span className="text-foreground font-mono text-[13px]">
                {data.config.orchestrator.epicConcurrency}
              </span>
            </div>
            {data.config.orchestrator.maxBudgetUsd !== undefined && (
              <div className="border-border flex items-center gap-3 border-b py-2">
                <span className="text-muted-foreground w-48 flex-shrink-0 text-[13px]">
                  Max budget per run
                </span>
                <span className="text-foreground font-mono text-[13px]">
                  ${data.config.orchestrator.maxBudgetUsd.toFixed(2)}
                </span>
              </div>
            )}
            <p className="text-muted-foreground pt-2 text-[11px]">
              Edit <code className="font-mono">.dispatch/config.yml</code> in
              the project to change these — this view is read-only.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
