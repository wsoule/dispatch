import { AlertCircle, Check, FolderSearch } from 'lucide-react';
import { useState } from 'react';

import { describeDaemonError } from '../components/shell/DaemonUnavailable';
import { StatTile } from '../components/ui/StatTile';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { MODELS, readDefaultModel, writeDefaultModel } from '../lib/models';
import { cn } from '@/lib/utils';
import { Badge } from '@/ui/badge';
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
  return data.client !== null ? 'bg-primary' : 'bg-red-500';
}

function daemonStatusLabel(data: DispatchProjectData): string {
  if (data.portLoading) return 'starting';
  return data.client !== null ? 'running' : 'not running';
}

// The one writable setting: which Claude model new dispatches use by default. Persisted to
// localStorage (see lib/models.ts) and read by useDispatchProject.handleDispatch, so changing
// it here changes what every subsequent "Dispatch" runs with — overridable per-dispatch from
// the task detail's model picker.
function DefaultModelSection() {
  const [selected, setSelected] = useState(readDefaultModel);
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        Default model
      </h2>
      <div className="flex flex-col gap-1.5">
        {MODELS.map((model) => {
          const active = model.id === selected;
          return (
            <button
              key={model.id}
              type="button"
              onClick={() => {
                writeDefaultModel(model.id);
                setSelected(model.id);
              }}
              className={cn(
                'flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors duration-150',
                active
                  ? 'border-primary/50 bg-primary/5'
                  : 'border-border hover:bg-muted/40'
              )}
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-foreground text-[13px] font-medium">
                  {model.label}
                </span>
                <span className="text-muted-foreground text-[11px]">
                  {model.hint}
                </span>
              </div>
              {active && <Check className="text-primary size-4 shrink-0" />}
            </button>
          );
        })}
      </div>
    </section>
  );
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

      <DefaultModelSection />

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
