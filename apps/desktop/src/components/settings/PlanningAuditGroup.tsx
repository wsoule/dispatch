import { EmptyState, Register, RegisterCell, RegisterRow } from '@dispatch/ui';
import { useQuery } from '@tanstack/react-query';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { formatRelativeTimeFromIso } from '../../lib/format';
import { SettingsGroup } from './SettingsGroup';

// Settings → Planning → Audit (Better Tracker's Settings → Audit): every
// change made in the app to the planning settings, watchers and milestone
// weights, with who made it, when, and the value before and after. The
// daemon records it when it saves (GET /api/planning/audit).

const COLUMNS = '110px minmax(0, 1fr) minmax(0, 1.2fr) minmax(90px, 0.6fr)';
const HEADER = [
  { id: 'when', label: 'When' },
  { id: 'what', label: 'What' },
  { id: 'change', label: 'Before → after' },
  { id: 'who', label: 'Who' },
];

interface Props {
  data: Pick<DispatchProjectData, 'client' | 'port' | 'people' | 'config'>;
}

export function PlanningAuditGroup({ data }: Props) {
  const { client, port, people, config } = data;
  // Keyed on the planning block: a save (config.changed refetches the config)
  // is what adds entries, and the app's queries never go stale on their own.
  const q = useQuery({
    queryKey: ['planning-audit', port, config?.planning],
    enabled: client !== null,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchPlanningAudit();
    },
  });
  const entries = q.data ?? [];
  const nameOf = (ref: string) =>
    people.find((person) => person.ref === ref)?.name ?? ref;

  return (
    <SettingsGroup
      title="Audit"
      hint="Changes made here to planning settings, watchers and milestone weights. Edits to config.yml by hand are not listed."
      keywords="history log changes who"
      requires="none"
    >
      {entries.length === 0 ? (
        <EmptyState>No changes yet.</EmptyState>
      ) : (
        <Register
          label="Planning changes"
          columns={COLUMNS}
          header={HEADER}
          stackWithin={600}
          stackedColumns="repeat(auto-fill, minmax(140px, 1fr))"
        >
          {entries.map((entry) => (
            <RegisterRow key={entry.id}>
              <RegisterCell label="When">
                {formatRelativeTimeFromIso(entry.at)}
              </RegisterCell>
              <RegisterCell label="What" variant="name">
                {entry.what}
              </RegisterCell>
              <RegisterCell label="Before → after">
                {`${entry.before ?? 'none'} → ${entry.after ?? 'none'}`}
              </RegisterCell>
              <RegisterCell label="Who">{nameOf(entry.by)}</RegisterCell>
            </RegisterRow>
          ))}
        </Register>
      )}
    </SettingsGroup>
  );
}
