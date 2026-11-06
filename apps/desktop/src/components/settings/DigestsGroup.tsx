import type { ConfigPatch, DispatchConfig } from '@dispatch-foo/core/browser';
import type { PlanningDigest, PlanningDigestRecord } from '@dispatch/client';
import {
  buildDigests,
  NOTICE_KIND_LABEL,
  planWarnings,
} from '@dispatch/planning';
import {
  Button,
  Chip,
  Dialog,
  EmptyState,
  Register,
  RegisterCell,
  RegisterRow,
  type UiTone,
} from '@dispatch/ui';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { usePlanningContext } from '../../hooks/usePlanning';
import { formatRelativeTimeFromIso } from '../../lib/format';
import { taskHref } from '../../lib/routes';
import { ModeSetting } from './fields';
import styles from './PlanningSection.module.css';
import { SettingsGroup, SettingsRow } from './SettingsGroup';

// Settings → Planning → Warnings (Better Tracker's warnings, its Status page's
// "Preview today's digests" and its Notifications log): whether the daemon
// sends each project lead and watcher a daily digest of milestones at risk,
// what today's digests would say (worked out here, by the same planning,
// sending nothing), and the digests the daemon sent or logged.

const KIND_TONE: Record<
  PlanningDigest['items'][number]['notice']['kind'],
  UiTone
> = {
  overdue: 'danger',
  at_risk: 'warning',
  invalid_due_soon: 'warning',
  allocation_blocked: 'warning',
};

const DELIVERY_LABEL: Record<PlanningDigestRecord['delivery'], string> = {
  webhook: 'Sent to the webhook',
  logged: 'Logged (no webhook)',
  failed: 'Not sent',
};

/** One digest: who it is for and each milestone it names, with why. */
function DigestView({ digest }: { digest: PlanningDigest }) {
  return (
    <Register
      label={`Digest for ${digest.recipientName}`}
      columns="minmax(0, 1fr) auto"
    >
      {digest.items.map((item) => (
        <RegisterRow
          key={`${item.notice.kind}:${item.notice.subjectId}`}
          href={taskHref(item.notice.milestoneId ?? item.notice.projectId)}
          rowLabel={`${item.projectName} ${item.milestoneName ?? ''}: ${NOTICE_KIND_LABEL[item.notice.kind]}`}
        >
          <RegisterCell variant="name" sub={item.lines.join(' · ')}>
            {item.milestoneName === null
              ? item.projectName
              : `${item.projectName} · ${item.milestoneName}`}
          </RegisterCell>
          <RegisterCell align="end">
            <Chip tone={KIND_TONE[item.notice.kind]}>
              {NOTICE_KIND_LABEL[item.notice.kind]}
            </Chip>
          </RegisterCell>
        </RegisterRow>
      ))}
    </Register>
  );
}

/** Digests under their recipient's name. */
function DigestList({ digests }: { digests: readonly PlanningDigest[] }) {
  if (digests.length === 0) {
    return (
      <EmptyState>
        Nothing at risk: no one would hear anything today.
      </EmptyState>
    );
  }
  return (
    <div className={styles.digests}>
      {digests.map((digest) => (
        <section
          key={digest.recipientId}
          aria-label={`For ${digest.recipientName}`}
          className={styles.digest}
        >
          <h3 className={styles.digestTitle}>For {digest.recipientName}</h3>
          <DigestView digest={digest} />
        </section>
      ))}
    </div>
  );
}

interface Props {
  config: DispatchConfig;
  data: Pick<DispatchProjectData, 'client' | 'port'>;
  onSave: (patch: ConfigPatch) => Promise<unknown>;
}

export function DigestsGroup({ config, data, onSave }: Props) {
  const planning = usePlanningContext();
  const [previewing, setPreviewing] = useState(false);
  const watchers = config.planning?.watchers;
  const preview = useMemo(() => {
    if (!previewing || planning === null) return [];
    const plan = planWarnings({
      snapshot: planning.snapshot,
      ctx: planning.ctx,
      assessments: planning.assessments,
      allocationPlan: planning.allocation,
      memory: [],
      watcherUserIds: watchers ?? [],
    });
    return buildDigests({
      snapshot: planning.snapshot,
      ctx: planning.ctx,
      assessments: planning.assessments,
      notices: plan.notices,
      appUrl: '',
      workspaceId: '',
    });
  }, [previewing, planning, watchers]);

  const { client, port } = data;
  const log = useQuery({
    queryKey: ['planning-digests', port],
    enabled: client !== null,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchPlanningDigests();
    },
  });
  const records = log.data ?? [];

  return (
    <>
      <SettingsGroup
        title="Warnings"
        hint="A daily digest of milestones overdue, at risk or missing details, for each project's lead and the watchers."
        keywords="digest notify slack webhook"
      >
        <ModeSetting
          id="planning-warnings"
          title="Daily digest"
          subtitle="Notify: from 8:00 the daemon sends each digest to the notifications webhook (Settings → Notifications) and keeps it below. A milestone is mentioned again only when something about it changes."
          value={config.planning?.warnings ?? 'off'}
          choices={[
            { value: 'off', label: 'Off' },
            { value: 'notify', label: 'Notify' },
          ]}
          onSave={(warnings) => void onSave({ planning: { warnings } })}
        />
        <SettingsRow
          title="Preview today's digests"
          subtitle="What each person would hear now, worked out here. Nothing is sent."
          control={
            <Button
              size="sm"
              disabled={planning === null}
              onClick={() => setPreviewing(true)}
            >
              Preview
            </Button>
          }
        />
      </SettingsGroup>
      <SettingsGroup title="Recent digests" requires="none">
        {records.length === 0 ? (
          <EmptyState>No digests yet.</EmptyState>
        ) : (
          <div className={styles.digests}>
            {records.map((record) => (
              <section
                key={record.id}
                aria-label={`Digest for ${record.digest.recipientName}`}
                className={styles.digest}
              >
                <h3 className={styles.digestTitle}>
                  For {record.digest.recipientName} ·{' '}
                  {formatRelativeTimeFromIso(record.at)} ·{' '}
                  {record.error === null
                    ? DELIVERY_LABEL[record.delivery]
                    : `${DELIVERY_LABEL[record.delivery]}: ${record.error}`}
                </h3>
                <DigestView digest={record.digest} />
              </section>
            ))}
          </div>
        )}
      </SettingsGroup>
      <Dialog
        open={previewing}
        onClose={() => setPreviewing(false)}
        size="lg"
        title="Today's digests"
        description="A preview: nothing is sent."
      >
        <DigestList digests={preview} />
      </Dialog>
    </>
  );
}
