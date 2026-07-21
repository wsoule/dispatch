import { Pill } from '../components/ui/Pill';
import { StatTile } from '../components/ui/StatTile';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import './SettingsView.css';

interface SettingsViewProps {
  /** The one project this window is scoped to — just its filesystem path is needed here, so
   * this takes the same minimal `{ path, name }` shape `App.tsx` derives from
   * `currentProjectRoot()`, not the full Relay `ProjectSummary` (id/lang/stack/etc.) that
   * only makes sense for a row out of Relay's own multi-project database. */
  activeProject: { path: string; name: string } | null;
  data: DispatchProjectData;
}

/**
 * Daemon status and tracker config for the active project — read-only, since there's no
 * write path for either today (dispatchd's config comes from `.dispatch/config.yml` in the
 * repo, and the sidecar itself is process-managed, not something this view should be able to
 * kill/restart). No placeholder sections: only what actually exists renders.
 */
export function SettingsView({ activeProject, data }: SettingsViewProps) {
  if (activeProject === null) {
    return (
      <div className="settings-view">
        <h1 className="view-topbar-title">Settings</h1>
        <p className="settings-view-status">
          Select a project from the sidebar to see its daemon status and tracker
          config.
        </p>
      </div>
    );
  }

  return (
    <div className="settings-view">
      <h1 className="view-topbar-title">Settings</h1>

      <section className="settings-view-section">
        <h2 className="settings-view-section-title">Daemon</h2>
        <div className="settings-view-daemon-row">
          <Pill
            variant="status"
            tone={
              data.portLoading ? 'gray' : data.client !== null ? 'green' : 'red'
            }
          >
            {data.portLoading
              ? 'starting'
              : data.client !== null
                ? 'running'
                : 'not running'}
          </Pill>
          <span className="settings-view-daemon-path">
            {activeProject.path}
          </span>
        </div>
        {data.portError && (
          <p className="settings-view-status">
            Couldn&rsquo;t start dispatchd
            {data.portErrorDetail instanceof Error
              ? `: ${data.portErrorDetail.message}`
              : '.'}
          </p>
        )}
        {data.health !== undefined && (
          <div className="settings-view-stats">
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
        <section className="settings-view-section">
          <h2 className="settings-view-section-title">Tracker config</h2>
          <div className="settings-view-config-row">
            <span className="settings-view-config-label">Statuses</span>
            <div className="settings-view-config-pills">
              {data.config.statuses.map((status) => (
                <Pill key={status} variant="tag" tone="gray">
                  {status}
                </Pill>
              ))}
            </div>
          </div>
          <div className="settings-view-config-row">
            <span className="settings-view-config-label">Auto-commit</span>
            <span className="settings-view-config-value">
              {data.config.autoCommit ? 'enabled' : 'disabled'}
            </span>
          </div>
          <div className="settings-view-config-row">
            <span className="settings-view-config-label">Max turns</span>
            <span className="settings-view-config-value">
              {data.config.orchestrator.maxTurns}
            </span>
          </div>
          <div className="settings-view-config-row">
            <span className="settings-view-config-label">Permission mode</span>
            <span className="settings-view-config-value">
              {data.config.orchestrator.permissionMode}
            </span>
          </div>
          <div className="settings-view-config-row">
            <span className="settings-view-config-label">
              Default epic concurrency
            </span>
            <span className="settings-view-config-value">
              {data.config.orchestrator.epicConcurrency}
            </span>
          </div>
          {data.config.orchestrator.maxBudgetUsd !== undefined && (
            <div className="settings-view-config-row">
              <span className="settings-view-config-label">
                Max budget per run
              </span>
              <span className="settings-view-config-value">
                ${data.config.orchestrator.maxBudgetUsd.toFixed(2)}
              </span>
            </div>
          )}
          <p className="settings-view-config-hint">
            Edit <code>.dispatch/config.yml</code> in the project to change
            these — this view is read-only.
          </p>
        </section>
      )}
    </div>
  );
}
