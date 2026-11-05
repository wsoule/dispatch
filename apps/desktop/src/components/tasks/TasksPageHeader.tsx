import type { ReactNode } from 'react';

import { PageHead } from '../shell/PageHead';
import styles from './TasksPageHeader.module.css';

// Re-exported for the pages that lead their own head with the back chip
// (Projects, Files, Live…); it lives beside PageHead, which renders it too.
export { TasksBackButton } from '../shell/PageHead';

/** A side page's head under Tasks: the back chip, then a compact crumb and
 * its actions, in a bar ruled off from the page below. */
export function TasksPageHeader({
  onBack,
  crumb,
  actions,
}: {
  onBack: () => void;
  crumb: ReactNode[];
  actions?: ReactNode;
}) {
  return (
    <div className={styles.bar}>
      <PageHead onBack={onBack} crumbs={crumb} actions={actions} />
    </div>
  );
}

/** A crumb segment that walks back up, such as "All docs" above an open doc. */
export function CrumbLink({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className={styles.crumbLink} onClick={onClick}>
      {children}
    </button>
  );
}
