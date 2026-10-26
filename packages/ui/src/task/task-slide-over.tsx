'use client';

import type { ReactNode } from 'react';

import SlideOver from '../shell/slide-over';
import { DEFAULT_TASK_LABELS, isClosedState } from './shared';
import { TaskCrumbs } from './task-crumbs';
import { TaskDetail } from './task-detail';
import styles from './task-detail.module.css';
import type { TaskSlideOverProps } from './types';

/**
 * A task in the shell's slide-over: the drawer's header bar carries the
 * breadcrumb and header actions, its h2 the title (or `titleControl`), and
 * TaskDetail (drawer layout, no header of its own) fills the body with
 * sections at h3. Focus, Esc and the phone scrim stay the SlideOver's.
 *
 * When the drawer swaps to another task while open (a relation row opened
 * in place), the task key is the SlideOver's `contentKey`: the body
 * scrolls back to the top and focus that was inside the drawer moves to
 * the panel, so assistive tech announces the new title and Tab starts from
 * the top.
 */
export function TaskSlideOver({
  open,
  onClose,
  closeLabel,
  initialFocusRef,
  ...detail
}: TaskSlideOverProps): ReactNode {
  return (
    <SlideOver
      open={open}
      onClose={onClose}
      closeLabel={closeLabel}
      initialFocusRef={initialFocusRef}
      contentKey={detail.taskKey}
      title={
        // A host's title editor goes in the drawer's heading as is; plain
        // titles read in their own direction and go quiet once closed,
        // like the page layout's.
        detail.titleControl !== undefined &&
        detail.titleControl !== null &&
        detail.titleControl !== false ? (
          detail.titleControl
        ) : (
          <span
            dir="auto"
            className={
              isClosedState(detail.status.kind) ? styles.closedTitle : undefined
            }
            data-closed={isClosedState(detail.status.kind) ? 'true' : undefined}
          >
            {detail.title}
          </span>
        )
      }
      breadcrumb={
        <TaskCrumbs
          breadcrumb={detail.breadcrumb}
          taskKey={detail.taskKey}
          label={detail.labels?.breadcrumb ?? DEFAULT_TASK_LABELS.breadcrumb}
        />
      }
      actions={detail.headerActions}
    >
      <TaskDetail {...detail} layout="drawer" header={false} headingLevel={2} />
    </SlideOver>
  );
}
