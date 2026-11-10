import {
  Button,
  EmptyState,
  ProgressPie,
  Register,
  RegisterCell,
  RegisterRow,
} from '@dispatch/ui';
import { Waypoints, Workflow, Zap } from 'lucide-react';

import { ContainerIcon } from '../tasks/page/ContainerIcon';
import type { ReadyContainer } from './liveGraph';
import styles from './LiveReady.module.css';

const ICON = { size: 14, strokeWidth: 1.8, 'aria-hidden': true } as const;

interface LiveReadyProps {
  containers: readonly ReadyContainer[];
  refFor: (id: string) => string;
  onSendAgents: (containerId: string) => void;
  onOpenPlan: (containerId: string) => void;
}

/**
 * The Live view with nothing in flight: what could be, as the milestones and parent
 * issues with the most work a fan-out would start now. A library EmptyState says why the
 * view is empty, then a Register lists each container (its glyph, title and reference,
 * how much of it is ready) with Send agents… and a way into its Flight Plan.
 */
export function LiveReady({
  containers,
  refFor,
  onSendAgents,
  onOpenPlan,
}: LiveReadyProps) {
  return (
    <div data-slot="live-empty" className={styles.empty}>
      <EmptyState
        label="Nothing in flight"
        icon={<Workflow size={22} strokeWidth={1.8} aria-hidden />}
      >
        {containers.length === 0
          ? 'No agent is running and nothing is ready to start. Plan work, and its waves show here as agents pick it up.'
          : 'Send agents at a milestone and its waves show here, live — blocked work starts on its own as its blockers land.'}
      </EmptyState>
      {containers.length > 0 && (
        <div className={styles.list}>
          <Register
            label="Ready to start"
            columns="minmax(0, 1fr) auto auto auto"
            stackWithin={600}
          >
            {containers.map(({ container, ready, total }) => {
              const id = container.meta.id;
              const title = container.meta.title;
              return (
                <RegisterRow
                  key={id}
                  data-slot="live-ready-row"
                  data-container={id}
                >
                  <RegisterCell variant="name">
                    <span className={styles.name}>
                      <ContainerIcon
                        kind={container.meta.kind}
                        icon={container.meta.icon}
                        color={container.meta.color}
                      />
                      <span className={styles.title}>{title}</span>
                    </span>
                  </RegisterCell>
                  <RegisterCell variant="mono">
                    <span className={styles.ref}>{refFor(id)}</span>
                  </RegisterCell>
                  <RegisterCell variant="mono">
                    <span className={styles.ready}>
                      <ProgressPie
                        done={ready}
                        total={total}
                        size={14}
                        label={`${ready} of ${total} ready`}
                      />
                      {ready} ready of {total}
                    </span>
                  </RegisterCell>
                  <RegisterCell align="end">
                    <span className={styles.actions}>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Zap {...ICON} />}
                        onClick={() => onSendAgents(id)}
                      >
                        Send agents…
                      </Button>
                      <Button
                        variant="quiet"
                        size="sm"
                        aria-label={`Open the Flight Plan for ${title}`}
                        icon={<Waypoints {...ICON} />}
                        onClick={() => onOpenPlan(id)}
                      />
                    </span>
                  </RegisterCell>
                </RegisterRow>
              );
            })}
          </Register>
        </div>
      )}
    </div>
  );
}
