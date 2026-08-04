import { AlertCircle } from 'lucide-react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { describeDaemonError } from '../shell/DaemonUnavailable';
import { Badge } from '@/ui/badge';
import { HintText, MetaText, Panel, PanelHeader, PanelRow } from '@/ui/chrome';
import { StatTile } from '@/ui/chrome/StatTile';

interface DaemonSectionProps {
  activeProject: { path: string; name: string };
  data: DispatchProjectData;
}

// The dot is decorative — `daemonStatusLabel`'s text sits right beside it and
// carries the same information, so the dot itself is `aria-hidden`.
function daemonDotClass(data: DispatchProjectData): string {
  if (data.portLoading) return 'bg-muted-foreground/40';
  return data.client !== null ? 'bg-primary' : 'bg-state-failed';
}

function daemonStatusLabel(data: DispatchProjectData): string {
  if (data.portLoading) return 'starting';
  return data.client !== null ? 'running' : 'not running';
}

/** Daemon health, plus the one tracker-config field that stays read-only everywhere:
 *  ported from `SettingsView` (max turns/permission mode/concurrency/budget moved to
 *  `AgentsSection`, auto-commit to `GeneralSection` — carrying them here too would show
 *  two different truths for the same setting). */
export function DaemonSection({ activeProject, data }: DaemonSectionProps) {
  return (
    <>
      <Panel>
        <PanelHeader>Daemon</PanelHeader>

        <PanelRow className="flex-col items-stretch gap-1.5">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={`size-1.5 flex-shrink-0 rounded-full ${daemonDotClass(data)}`}
            />
            <span className="text-[13px]">{daemonStatusLabel(data)}</span>
            <MetaText>{activeProject.path}</MetaText>
          </div>

          {data.portError && (
            <div className="flex flex-col gap-1.5">
              <p className="text-state-failed flex items-center gap-1.5 text-[13px]">
                <AlertCircle className="size-3.5 flex-shrink-0" />
                Couldn&rsquo;t start dispatchd
              </p>
              {describeDaemonError(data.portErrorDetail) !== null && (
                <pre className="dense-meta bg-muted/40 max-h-48 overflow-auto rounded p-3 text-left whitespace-pre-wrap">
                  {describeDaemonError(data.portErrorDetail)}
                </pre>
              )}
            </div>
          )}
        </PanelRow>

        {data.health !== undefined && (
          <PanelRow className="grid grid-cols-3 gap-3">
            <StatTile
              value={data.health.pr ? 'Yes' : 'No'}
              label="PR capability"
            />
            <StatTile value={data.tasks.length} label="Tasks tracked" />
            <StatTile value={data.runs.length} label="Runs recorded" />
          </PanelRow>
        )}
      </Panel>

      {data.config !== null && (
        <Panel>
          <PanelHeader>Tracker config</PanelHeader>

          <PanelRow className="flex-col items-stretch gap-1.5">
            <span className="text-[12px]">Statuses</span>
            <div className="flex flex-wrap gap-1">
              {data.config.statuses.map((status) => (
                <Badge key={status} variant="outline">
                  {status}
                </Badge>
              ))}
            </div>
          </PanelRow>

          <PanelRow>
            <HintText>
              Statuses stay in .dispatch/config.yml. Every task file on disk
              stores its status by name, so removing one here would orphan those
              tasks.
            </HintText>
          </PanelRow>
        </Panel>
      )}
    </>
  );
}
