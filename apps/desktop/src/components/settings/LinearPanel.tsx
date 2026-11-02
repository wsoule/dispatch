import { statusModelOf } from '@dispatch-foo/core/browser';
import type { LinearConfig, StatusRoles } from '@dispatch-foo/core/browser';
import { LINEAR_USAGE_LIMIT_MESSAGE } from '@dispatch/client';
import type {
  LinearSyncSummary,
  LinearTeam,
  LinearViewer,
} from '@dispatch/client';
import { Button, Checkbox, Select, TextField } from '@dispatch/ui';
import { CheckCircle2, CircleAlert, RefreshCw, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { formatRelativeTimeFromIso } from '../../lib/format';
import {
  capacityPaused,
  describeBulkOutcome,
  describeFetchFailure,
  describeLinearDelivery,
  describeMigrated,
  formatLinearProgress,
  formatSyncCounts,
  isLinearConfigured,
  linearKeySourceNote,
  progressFor,
  STATUS_ROLE_ROWS,
} from '../../lib/linearSettings';
import { useSettingsAccess } from './access';
import { SettingsSwitch } from './fields';
import { LinearCapacityGroup } from './LinearCapacityGroup';
import { LinearCoverageGroup } from './LinearCoverageGroup';
import { LinearExportDialog } from './LinearExportDialog';
import styles from './LinearPanel.module.css';
import {
  SettingsGroup,
  SettingsHint,
  SettingsRow,
  useGroupLocked,
} from './SettingsGroup';

const LINEAR_DIRECTIONS: { value: 'both' | 'pull' | 'push'; label: string }[] =
  [
    { value: 'both', label: 'Pull and push' },
    { value: 'pull', label: 'Pull only (Linear → Dispatch)' },
    { value: 'push', label: 'Push only (Dispatch → Linear)' },
  ];

// A select value for "no status": an option's value can't be null.
const NO_STATUS = '__none__';

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
      subtitle="At least 30 seconds. Used when no webhook delivers changes."
      keywords="poll interval"
      htmlFor="linear-poll-interval"
      control={
        <span className={styles.intervalBox}>
          <TextField
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
            className={styles.interval}
          />
        </span>
      }
    />
  );
}

/** One lifecycle role: which of the team's statuses Dispatch writes for it. */
function StatusRoleRow({
  title,
  subtitle,
  value,
  statuses,
  optional,
  onChange,
}: {
  title: string;
  subtitle: string;
  value: string | null;
  statuses: readonly string[];
  optional: boolean;
  onChange: (status: string | null) => void;
}) {
  return (
    <SettingsRow
      title={title}
      subtitle={subtitle}
      control={
        <Select
          label={`${title} status`}
          value={value ?? (optional ? NO_STATUS : null)}
          options={[
            ...(optional ? [{ value: NO_STATUS, label: 'None' }] : []),
            ...statuses.map((status) => ({ value: status, label: status })),
          ]}
          className={styles.select}
          onChange={(next) => onChange(next === NO_STATUS ? null : next)}
        />
      }
    />
  );
}

// The linked teams, primary first; a config from a daemon predating several
// teams carries only `teamId`.
function linkedTeamIds(linear: LinearConfig): string[] {
  if (Array.isArray(linear.teamIds)) return linear.teamIds;
  return linear.teamId === null || linear.teamId.trim() === ''
    ? []
    : [linear.teamId];
}

/** One team of the workspace: a checkbox links it, and a linked team other than the
 *  primary can become the primary, where new issues go. */
function LinkedTeamRow({
  team,
  linked,
  onChange,
}: {
  team: LinearTeam;
  linked: readonly string[];
  onChange: (teamIds: string[]) => void;
}) {
  const at = linked.indexOf(team.id);
  const others = linked.filter((id) => id !== team.id);
  // The checkbox's own element escapes a locked group's disabled fieldset.
  const locked = useGroupLocked();
  return (
    <SettingsRow
      title={`${team.name} (${team.key})`}
      subtitle={
        at === 0
          ? 'Primary: new issues go here, unless their parent issue is in another linked team.'
          : undefined
      }
      control={
        <span className={styles.inline}>
          {at > 0 && (
            <Button
              variant="secondary"
              size="sm"
              disabled={locked}
              onClick={() => onChange([team.id, ...others])}
            >
              Make primary
            </Button>
          )}
          <Checkbox
            label={`Link ${team.name}`}
            hideLabel
            checked={at >= 0}
            disabled={locked}
            onChange={(checked) =>
              onChange(checked ? [...others, team.id] : others)
            }
          />
        </span>
      }
    />
  );
}

/** A failed teams fetch, rendered above the control it starved — the actionable reason
 *  plus a retry, instead of letting the picker sit there empty with no explanation. */
function FetchFailureRow({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <div className={styles.failureRow}>
      <span className={styles.failureText}>{describeFetchFailure(error)}</span>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/** Linear sync settings: connect a write-only API key, pick the team/direction/interval,
 *  choose which of the team's statuses each lifecycle role writes, and run a sync on demand. */
export function LinearPanel({ data }: { data: DispatchProjectData }) {
  const { linearStatus, linearTeams, config } = data;
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
  const [exportOpen, setExportOpen] = useState(false);
  // The key decides whose Linear account the board is sent to, so the daemon
  // lets only the owner set or remove it; import and sync just use it.
  const { canOperate } = useSettingsAccess();
  // Coverage, capacity and the export preview are fetched only while shown.
  const { watchLinearDetails } = data;
  useEffect(() => watchLinearDetails(), [watchLinearDetails]);

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
  const linkedTeams = linkedTeamIds(config.linear);
  const teamChosen = linkedTeams.length > 0;
  // A linked team the picker has not loaded (a failed fetch) still shows.
  const teamRows: LinearTeam[] = [
    ...linearTeams,
    ...linkedTeams
      .filter((id) => !linearTeams.some((t) => t.id === id))
      .map((id) => ({ id, key: id, name: 'Unknown team' })),
  ];
  function setTeams(teamIds: string[]) {
    void data.handleUpdateConfig({ linear: { teamIds } });
  }
  const roles = statusModelOf(config).roles;
  function setRole(key: keyof StatusRoles, status: string | null) {
    void data.handleUpdateConfig({ statusRoles: { ...roles, [key]: status } });
  }
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
  const progress = linearStatus.progress ?? null;
  const conflicts = linearStatus.conflicts;
  const running = linearStatus.running ?? null;
  const coverage = linearStatus.coverage ?? null;
  const lastExport =
    linearStatus.lastExport?.action === 'export'
      ? linearStatus.lastExport
      : null;
  const pullOnly = config.linear.direction === 'pull';
  const exportBlocked = !configured || pullOnly || running !== null;
  // Offered once the link is made, until an export has run: linking mirrors
  // changes from then on, so the tasks made before it stay local otherwise.
  // Only those count: a task made since goes on its own, and a failed or
  // queued create has Retry under Coverage.
  const heldBack = coverage?.heldBack ?? 0;
  const offerExport =
    !exportBlocked &&
    linearStatus.bootstrappedAt !== null &&
    (linearStatus.lastExport ?? null) === null &&
    heldBack > 0;
  // The usage limit's message, unless an error line already shows it.
  const usageLimited =
    summary?.usageLimited === true || capacityPaused(linearStatus.capacity);
  const usageShown =
    summary?.errors.includes(LINEAR_USAGE_LIMIT_MESSAGE) === true ||
    (linearStatus.lastError === LINEAR_USAGE_LIMIT_MESSAGE &&
      !lastErrorInSummary);
  const teamName =
    linearTeams.find((t) => t.id === linearStatus.teamId)?.name ?? null;
  const migrated =
    summary === null ? null : describeMigrated(summary, teamName);
  const importProgress = progressFor(progress, 'import');
  const exportProgress = progressFor(progress, 'export');
  const exportOutcome = describeBulkOutcome(lastExport);

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
                <span className={styles.keyBox}>
                  <TextField
                    id="linear-api-key"
                    type="password"
                    autoComplete="off"
                    placeholder="Linear API key"
                    value={apiKey}
                    disabled={!canOperate}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                </span>
                <Button
                  variant="primary"
                  disabled={!canOperate || connecting || apiKey.trim() === ''}
                  onClick={() => void connect()}
                >
                  {connecting ? 'Connecting…' : 'Connect'}
                </Button>
              </>
            }
          >
            {connectError !== null && (
              <span className={styles.error}>{connectError}</span>
            )}
          </SettingsRow>
        )}

        {linearStatus.connected && (
          <SettingsRow
            title={
              <span className={styles.connected}>
                <CheckCircle2
                  aria-hidden
                  size={14}
                  strokeWidth={1.8}
                  className={styles.connectedIcon}
                />
                Connected{viewer !== null ? ` as ${viewer.name}` : ''}
              </span>
            }
            locked={linearStatus.keySource === 'project' && !canOperate}
            control={
              linearStatus.keySource === 'project' ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!canOperate || disconnecting}
                  onClick={() => void disconnect()}
                >
                  {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                </Button>
              ) : undefined
            }
          >
            {disconnectError !== null && (
              <span className={styles.error}>{disconnectError}</span>
            )}
          </SettingsRow>
        )}
      </SettingsGroup>

      {linearStatus.connected && (
        <SettingsGroup
          title="Sync settings"
          hint="Keeps this project’s tasks and the linked Linear teams as two faithful copies: every field both ways, projects and initiatives as containers, workflow states as statuses, members as people, labels with their colors, and comments. When both sides change the same field, the newer edit wins and the task’s Activity says so."
          keywords="linear direction acceptance"
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

          <SettingsRow
            title="Direction"
            control={
              <Select
                label="Direction"
                value={config.linear.direction}
                options={LINEAR_DIRECTIONS}
                className={styles.direction}
                onChange={(next) => {
                  const picked = LINEAR_DIRECTIONS.find(
                    (d) => d.value === next
                  );
                  if (picked !== undefined) {
                    void data.handleUpdateConfig({
                      linear: { direction: picked.value },
                    });
                  }
                }}
              />
            }
          />

          <LinearIntervalRow
            value={config.linear.intervalSec}
            onSave={(intervalSec) =>
              void data.handleUpdateConfig({ linear: { intervalSec } })
            }
          />

          <SettingsRow
            title="Send Acceptance Criteria to Linear"
            subtitle="Adds it to the issue description as its own section, so teammates see it."
            htmlFor="linear-acceptance"
            control={
              <SettingsSwitch
                id="linear-acceptance"
                checked={config.linear.includeAcceptanceCriteria}
                onCheckedChange={(checked) =>
                  void data.handleUpdateConfig({
                    linear: { includeAcceptanceCriteria: checked },
                  })
                }
              />
            }
          />

          <SettingsRow
            title="Archive finished tasks in Linear too"
            subtitle="When you archive a completed or canceled task here, its Linear issue is archived too, which frees room on a plan with an issue limit. Restoring the task leaves the issue archived."
            keywords="linear archive done finished limit"
            htmlFor="linear-archive-finished"
            control={
              <SettingsSwitch
                id="linear-archive-finished"
                // A config from a daemon predating the key carries none.
                checked={config.linear.archiveFinished ?? false}
                onCheckedChange={(checked) =>
                  void data.handleUpdateConfig({
                    linear: { archiveFinished: checked },
                  })
                }
              />
            }
          />
        </SettingsGroup>
      )}

      {linearStatus.connected && (
        <SettingsGroup
          title="Teams"
          keywords="linear team"
          hint="Link every team whose issues this project mirrors. An issue that moves between linked teams stays linked; one that leaves them all is unlinked. Your statuses are the linked teams’ workflow states, merged where a name and type match."
        >
          {data.linearTeamsError !== null && (
            <FetchFailureRow
              error={data.linearTeamsError}
              onRetry={() => data.refetchLinearTeams()}
            />
          )}
          {teamRows.length === 0 && data.linearTeamsError === null && (
            <SettingsRow title="No teams to show yet." />
          )}
          {teamRows.map((team) => (
            <LinkedTeamRow
              key={team.id}
              team={team}
              linked={linkedTeams}
              onChange={setTeams}
            />
          ))}
        </SettingsGroup>
      )}

      {linearStatus.connected && teamChosen && (
        <SettingsGroup
          title="Status roles"
          keywords="workflow states columns"
          hint="Your statuses are the team’s workflow states, kept in step on every sync: linking moves each task onto the matching state (ready to Todo, working to In Progress, landed to Done, dropped to Canceled), and disconnecting keeps these names. Each role picks the one Dispatch writes as work moves; a role you change here is kept across syncs."
        >
          {roles.review === roles.dispatched && (
            <div className={styles.calloutRow}>
              <div
                role="alert"
                data-testid="linear-no-review-state"
                className={styles.callout}
              >
                <CircleAlert
                  aria-hidden
                  size={14}
                  strokeWidth={1.8}
                  className={styles.calloutIcon}
                />
                <div className={styles.calloutText}>
                  <p className={styles.calloutTitle}>
                    Your team has no review state
                  </p>
                  <p className={styles.calloutBody}>
                    {`Finished runs stay in ${roles.dispatched} in Linear. Add an In Review state to the team’s workflow in Linear and the next sync picks it up.`}
                  </p>
                </div>
              </div>
            </div>
          )}
          {STATUS_ROLE_ROWS.map((row) => (
            <StatusRoleRow
              key={row.key}
              title={row.title}
              subtitle={row.subtitle}
              value={roles[row.key]}
              statuses={config.statuses}
              optional={row.key === 'landing'}
              onChange={(status) => setRole(row.key, status)}
            />
          ))}
        </SettingsGroup>
      )}

      {linearStatus.connected && (
        <SettingsGroup
          title="Sync"
          keywords="linear import export"
          requires="none"
        >
          {offerExport && (
            <div className={styles.calloutRow}>
              <div
                role="alert"
                data-testid="linear-export-offer"
                className={styles.callout}
              >
                <Upload
                  aria-hidden
                  size={14}
                  strokeWidth={1.8}
                  className={styles.calloutIcon}
                />
                <div className={styles.calloutText}>
                  <p className={styles.calloutTitle}>
                    {`${heldBack.toLocaleString('en-US')} task${heldBack === 1 ? '' : 's'} here ${heldBack === 1 ? 'isn’t' : 'aren’t'} in Linear yet`}
                  </p>
                  <div className={styles.calloutBody}>
                    <p>
                      Linking mirrors changes from now on. Export sends the
                      tasks you already have.
                    </p>
                    <Button
                      variant="primary"
                      size="sm"
                      className={styles.calloutAction}
                      onClick={() => setExportOpen(true)}
                    >
                      Export to Linear…
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          <SettingsRow
            title="Changes"
            subtitle={describeLinearDelivery(linearStatus)}
          />

          <SettingsRow
            title="Import from Linear"
            subtitle="Sync only carries changes to linked tasks. Import brings in every issue, project and comment in the linked teams that isn't here yet."
            control={
              <Button
                variant="secondary"
                size="sm"
                disabled={importing || !configured}
                onClick={() => void importFromLinear()}
              >
                {importing ? 'Importing…' : 'Import from Linear'}
              </Button>
            }
          >
            {importProgress !== null && (
              <SettingsHint>
                {formatLinearProgress(importProgress)}
              </SettingsHint>
            )}
            {importResult !== null && (
              <SettingsHint>{formatSyncCounts(importResult)}</SettingsHint>
            )}
            {importError !== null && (
              <span className={styles.error}>{importError}</span>
            )}
          </SettingsRow>

          <SettingsRow
            title="Export to Linear"
            subtitle={
              coverage === null
                ? 'Creates Linear issues for tasks that predate the link.'
                : `${coverage.linked.toLocaleString('en-US')} of ${coverage.total.toLocaleString('en-US')} tasks are in Linear. Export creates issues for the rest.`
            }
            keywords="push unlinked"
            control={
              <Button
                variant="secondary"
                size="sm"
                disabled={exportBlocked}
                onClick={() => setExportOpen(true)}
              >
                Export to Linear…
              </Button>
            }
          >
            {pullOnly && (
              <SettingsHint>
                Pull only: switch the direction to send tasks to Linear.
              </SettingsHint>
            )}
            {exportProgress !== null && (
              <SettingsHint>
                {formatLinearProgress(exportProgress)}
              </SettingsHint>
            )}
            {exportOutcome !== null && (
              <SettingsHint>{exportOutcome}</SettingsHint>
            )}
            {lastExport?.errors.map((message) => (
              <span key={message} className={styles.error}>
                {message}
              </span>
            ))}
          </SettingsRow>

          <SettingsRow
            title="Sync now"
            subtitle={
              linearStatus.lastSyncAt !== null
                ? `Last sync ${formatRelativeTimeFromIso(linearStatus.lastSyncAt)}.`
                : 'Not synced yet.'
            }
            control={
              <Button
                variant="secondary"
                size="sm"
                disabled={syncing || linearStatus.syncing || !configured}
                onClick={() => void sync()}
                icon={
                  <RefreshCw
                    size={14}
                    strokeWidth={1.8}
                    className={
                      syncing || linearStatus.syncing ? styles.spin : undefined
                    }
                  />
                }
              >
                {syncing || linearStatus.syncing ? 'Syncing…' : 'Sync now'}
              </Button>
            }
          >
            {linearStatus.lastError !== null && !lastErrorInSummary && (
              <span className={styles.error}>{linearStatus.lastError}</span>
            )}
            {summary !== null && (
              <div className={styles.summary}>
                <SettingsHint>{formatSyncCounts(summary)}</SettingsHint>
                {summary.errors.map((message, i) => (
                  <span
                    key={`${message}-${String(i)}`}
                    className={styles.error}
                  >
                    {message}
                  </span>
                ))}
                {summary.rateLimited && (
                  <span className={styles.error}>
                    Linear rate-limited this pass — it will retry on its own.
                  </span>
                )}
                {migrated !== null && <SettingsHint>{migrated}</SettingsHint>}
              </div>
            )}
            {usageLimited && !usageShown && (
              <span className={styles.error}>{LINEAR_USAGE_LIMIT_MESSAGE}</span>
            )}
            {syncError !== null && (
              <span className={styles.error}>{syncError}</span>
            )}
          </SettingsRow>

          {conflicts !== undefined && conflicts.total > 0 && (
            <SettingsRow
              title="Conflicts resolved"
              subtitle={`${String(conflicts.total)} field(s) changed on both sides since the link; the newer edit won each, and the task’s Activity notes it.`}
            />
          )}
        </SettingsGroup>
      )}

      {linearStatus.connected && (
        <LinearCoverageGroup data={data} configured={configured} />
      )}

      {linearStatus.connected && teamChosen && (
        <LinearCapacityGroup data={data} configured={configured} />
      )}

      <LinearExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        preview={data.linearExportPreview}
        previewError={data.linearExportPreviewError ?? null}
        capacity={data.linearCapacity}
        onExport={data.handleExportLinear}
      />
    </>
  );
}
