import type { UiTone } from '@dispatch/ui';
import { cx, StatsStrip } from '@dispatch/ui';
import { AlertCircle } from 'lucide-react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { RawText } from '../gr8r/RawText';
import { describeDaemonError } from '../shell/DaemonUnavailable';
import styles from './DaemonSection.module.css';
import { SettingsSearchable } from './search';
import { SettingsGroup, SettingsRow } from './SettingsGroup';

interface DaemonSectionProps {
  activeProject: { path: string; name: string };
  data: DispatchProjectData;
}

// The dot is decorative — `daemonStatusLabel`'s text sits right beside it and
// carries the same information, so the dot itself is `aria-hidden`.
function daemonDotTone(data: DispatchProjectData): UiTone {
  if (data.portLoading) return 'muted';
  return data.client !== null ? 'success' : 'danger';
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
          subtitle={<span className={styles.path}>{activeProject.path}</span>}
          keywords="daemon dispatchd"
          control={
            <span className={styles.status}>
              <span
                aria-hidden="true"
                data-tone={daemonDotTone(data)}
                className={styles.dot}
              />
              {daemonStatusLabel(data)}
            </span>
          }
        >
          {data.portError && (
            <div className={styles.failure}>
              <p className={cx('toneText', styles.failed)} data-tone="danger">
                <AlertCircle aria-hidden size={14} strokeWidth={1.8} />
                Dispatch couldn&rsquo;t start for this project
              </p>
              {errorDetail !== null && <RawText>{errorDetail}</RawText>}
            </div>
          )}
        </SettingsRow>

        {data.health !== undefined && (
          <SettingsSearchable text="tasks runs pull requests github">
            <div className={styles.stats}>
              <StatsStrip
                label="This project"
                cells={[
                  { id: 'tasks', value: data.tasks.length, label: 'Tasks' },
                  { id: 'runs', value: data.runs.length, label: 'Runs' },
                  {
                    id: 'pr',
                    value: data.health.pr ? 'Connected' : 'Not set up',
                    label: 'Pull requests',
                  },
                ]}
              />
            </div>
          </SettingsSearchable>
        )}
      </SettingsGroup>
    </>
  );
}
