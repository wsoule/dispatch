import { createElement, type ReactNode } from 'react';

import type { TaskStateKind } from '../tasks/types';
import type { TaskDetailLabels } from './types';

// Small pure helpers shared by the task family. Deliberately not a client
// module: the read-only parts (TaskDetail, TaskRelationList without
// callbacks, TaskPropertyValue) render in a server component too.

export const DEFAULT_TASK_LABELS: TaskDetailLabels = {
  properties: 'Properties',
  propertiesList: 'Task details',
  description: 'Description',
  noDescription: 'No description',
  loadingDescription: 'Loading description',
  error: 'Error',
  retry: 'Retry',
  showMore: 'Show more',
  showLess: 'Show less',
  blockedBy: 'Blocked by',
  blocks: 'Blocks',
  nothingBlocks: 'Nothing blocks this task.',
  blocksNothing: 'Nothing waits on this task.',
  activity: 'Activity',
  noActivity: 'No activity yet.',
  showAll: 'Show all',
  showFewer: 'Show fewer',
  external: 'Outside view',
  resolved: 'Resolved',
  unassigned: 'Unassigned',
  breadcrumb: 'Breadcrumb',
  opensInNewTab: 'opens in a new tab',
  remove: 'Remove',
  comments: 'Comments',
  noComments: 'No comments yet.',
  loadingComments: 'Loading comments',
  openComment: 'Open comment',
  notSaved: 'Not saved',
};

/** True for absolute http(s) URLs: the tracker, not a host route. Those
    open in a new tab and render as a plain anchor (see lib/link). */
export function isExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

/** Done and canceled tasks: nothing left to do, so the view goes quiet. */
export function isClosedState(kind: TaskStateKind): boolean {
  return kind === 'completed' || kind === 'canceled';
}

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** Clamps a computed heading level into h1…h6. */
export function headingLevel(level: number): HeadingLevel {
  return Math.min(6, Math.max(1, Math.round(level))) as HeadingLevel;
}

/** An h1…h6 chosen at run time, so a host can nest the view anywhere in
    its outline. */
export function Heading({
  level,
  id,
  className,
  dir,
  children,
}: {
  level: number;
  id?: string;
  className?: string;
  /** 'auto' for text from the tracker, so a right-to-left title reads in
      its own direction. */
  dir?: 'auto';
  children: ReactNode;
}): ReactNode {
  return createElement(
    `h${headingLevel(level)}`,
    { id, className, dir },
    children
  );
}
