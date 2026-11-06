import type {
  ConfigPatch,
  DispatchConfig,
  Person,
  PlanningProjectStatus,
  PlanningTuningNumber,
} from '@dispatch-foo/core/browser';
import { Checkbox, EmptyState } from '@dispatch/ui';

import { PROJECT_STATUSES, tuningFrom } from '../../adapters/planningSettings';
import { NumberSetting } from './fields';
import styles from './PlanningSection.module.css';
import { SettingsGroup, SettingsRow } from './SettingsGroup';

// Settings → Planning (Better Tracker's Settings → Schedule and Watchers): the
// numbers the milestone planner judges risk and draws the timeline with, which
// project statuses count as active, and who hears about every at-risk
// milestone. Everything saves to config.yml's `planning:` block; an emptied
// number goes back to the planning's default.

interface TuningField {
  key: PlanningTuningNumber;
  title: string;
  subtitle: string;
  /** The smallest value the config accepts. */
  min: number;
}

const RISK_FIELDS: readonly TuningField[] = [
  {
    key: 'warnLeadDays',
    title: 'Warn ahead',
    subtitle:
      'A milestone missing a date, a lead or "Done means…" is called out this many days before it is due.',
    min: 0,
  },
  {
    key: 'stallDays',
    title: 'Stalled after',
    subtitle:
      'A milestone whose issues have not moved for this long is at risk.',
    min: 0,
  },
  {
    key: 'paceWindowDays',
    title: 'Pace window',
    subtitle:
      'Behind pace means more work left than this window of recent progress can finish in time.',
    min: 0,
  },
  {
    key: 'overdueRepeatDays',
    title: 'Repeat overdue every',
    subtitle: 'How often an overdue milestone is mentioned again.',
    min: 1,
  },
  {
    key: 'newBadgeDays',
    title: 'New mark lasts',
    subtitle: 'How long an allocated issue stays marked new in My week.',
    min: 0,
  },
];

const TIMELINE_FIELDS: readonly TuningField[] = [
  {
    key: 'timelineDaysBack',
    title: 'Timeline looks back',
    subtitle: 'Days before today the timeline starts at.',
    min: 0,
  },
  {
    key: 'timelineDaysAhead',
    title: 'Timeline looks ahead',
    subtitle: 'Days after today the timeline runs to.',
    min: 0,
  },
];

const STATUS_LABEL: Record<PlanningProjectStatus, string> = {
  backlog: 'Backlog',
  planned: 'Planned',
  started: 'In progress',
  paused: 'Paused',
  completed: 'Completed',
  canceled: 'Canceled',
};

interface Props {
  config: DispatchConfig;
  /** The people a project could name as a watcher. */
  people: readonly Person[];
  onSave: (patch: ConfigPatch) => Promise<unknown>;
}

export function PlanningSection({ config, people, onSave }: Props) {
  const tuning = tuningFrom(config.planning);
  const set = config.planning?.tuning ?? {};
  const watchers = new Set(config.planning?.watchers ?? []);
  const active = new Set<string>(tuning.activeProjectStatuses);

  const numberRow = (field: TuningField) => (
    <NumberSetting
      key={field.key}
      id={`planning-${field.key}`}
      title={field.title}
      subtitle={field.subtitle}
      keywords="planning tuning"
      value={set[field.key]}
      placeholder={String(tuning[field.key])}
      min={field.min}
      max={365}
      suffix="days"
      allowEmpty
      onSave={(value) =>
        void onSave({ planning: { tuning: { [field.key]: value } } })
      }
    />
  );

  const toggleStatus = (status: PlanningProjectStatus, on: boolean) => {
    const next = PROJECT_STATUSES.filter((each) =>
      each === status ? on : active.has(each)
    ) as PlanningProjectStatus[];
    // At least one status stays active: the last box cannot be cleared.
    if (next.length === 0) return;
    void onSave({ planning: { tuning: { activeProjectStatuses: next } } });
  };

  const toggleWatcher = (ref: string, on: boolean) => {
    const next = new Set(watchers);
    if (on) next.add(ref);
    else next.delete(ref);
    void onSave({ planning: { watchers: [...next] } });
  };

  return (
    <>
      <SettingsGroup
        title="Risk"
        hint="Empty fields use the default shown in grey."
        keywords="warnings milestones"
      >
        {RISK_FIELDS.map(numberRow)}
      </SettingsGroup>
      <SettingsGroup title="Active projects" keywords="allocation statuses">
        <SettingsRow
          title="Statuses that count as active"
          subtitle="Only active projects are allocated and warned about; the rest are listed quietly."
          stacked
          control={
            <div className={styles.choices}>
              {(PROJECT_STATUSES as PlanningProjectStatus[]).map((status) => (
                <Checkbox
                  key={status}
                  label={STATUS_LABEL[status]}
                  checked={active.has(status)}
                  disabled={active.has(status) && active.size === 1}
                  onChange={(on) => toggleStatus(status, on)}
                />
              ))}
            </div>
          }
        />
      </SettingsGroup>
      <SettingsGroup title="Timeline" keywords="window">
        {TIMELINE_FIELDS.map(numberRow)}
      </SettingsGroup>
      <SettingsGroup
        title="Watchers"
        hint="Watchers hear about every at-risk milestone, besides its project's lead."
        keywords="notify people"
      >
        {people.length === 0 ? (
          <EmptyState>No people yet.</EmptyState>
        ) : (
          <SettingsRow
            title="People"
            stacked
            control={
              <div className={styles.choices}>
                {people.map((person) => (
                  <Checkbox
                    key={person.ref}
                    label={person.name}
                    checked={watchers.has(person.ref)}
                    onChange={(on) => toggleWatcher(person.ref, on)}
                  />
                ))}
              </div>
            }
          />
        )}
      </SettingsGroup>
    </>
  );
}
