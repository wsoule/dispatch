import { AlertCircle } from 'lucide-react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { describeDaemonError } from '../shell/DaemonUnavailable';
import { SettingsSearchable } from './search';
import { SettingsGroup, SettingsRow } from './SettingsGroup';
import { cn } from '@/lib/utils';
import { PanelRow } from '@/ui/chrome';
import { StatTile } from '@/ui/chrome/StatTile';

interface DaemonSectionProps {
  activeProject: { path: string; name: string };
  data: DispatchProjectData;
}

// The dot is decorative — `daemonStatusLabel`'s text sits right beside it and
// carries the same information, so the dot itself is `aria-hidden`.
function daemonDotClass(data: DispatchProjectData): string {
  if (data.portLoading) return 'bg-muted-foreground/40';
  return data.client !== null ? 'bg-state-review' : 'bg-state-failed';
}

function daemonStatusLabel(data: DispatchProjectData): string {
  if (data.portLoading) return 'Starting';
  return data.client !== null ? 'Running' : 'Not running';
}

/** Whether Dispatch's own process for this project is up, and what it holds.
 *  Its settings are DaemonConfigGroups, rendered below this on the page. */
export function DaemonSection({ activeProject, data }: DaemonSectionProps) {
  const errorDetail = describeDaemonError(data.portErrorDetail);
  return (
    <>
      <SettingsGroup
        title="Status"
        keywords="daemon dispatchd running"
        requires="none"
      >
        <SettingsRow
          title="Dispatch for this project"
          subtitle={
            <span className="font-mono break-all">{activeProject.path}</span>
          }
          keywords="daemon dispatchd"
          control={
            <span className="font-book flex items-center gap-2 text-[12px] text-(--text-secondary)">
              <span
                aria-hidden="true"
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  daemonDotClass(data)
                )}
              />
              {daemonStatusLabel(data)}
            </span>
          }
        >
          {data.portError && (
            <div className="flex flex-col gap-1.5">
              <p className="text-state-failed flex items-center gap-1.5 text-[13px]">
                <AlertCircle className="size-3.5 shrink-0" />
                Dispatch couldn&rsquo;t start for this project
              </p>
              {errorDetail !== null && (
                <pre className="bg-surface-quaternary text-muted-foreground rounded-control max-h-48 overflow-auto p-3 text-left font-mono text-[12px] whitespace-pre-wrap">
                  {errorDetail}
                </pre>
              )}
            </div>
          )}
        </SettingsRow>

        {data.health !== undefined && (
          <SettingsSearchable text="tasks runs pull requests github">
            <PanelRow className="grid grid-cols-3 gap-3 py-3">
              <StatTile value={data.tasks.length} label="Tasks" />
              <StatTile value={data.runs.length} label="Runs" />
              <StatTile
                value={data.health.pr ? 'Connected' : 'Not set up'}
                label="Pull requests"
              />
            </PanelRow>
          </SettingsSearchable>
        )}
      </SettingsGroup>
    </>
  );
}
