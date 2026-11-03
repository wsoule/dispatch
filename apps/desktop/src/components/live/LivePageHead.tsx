import { Button } from '@dispatch/ui';
import { ChevronLeft } from 'lucide-react';

import { LIVE_PAGE_TITLE } from '../../lib/shellRoutes';
import { PageHead } from '../shell/PageHead';
import styles from './LivePageHead.module.css';

/** The chip the Live page leads with: a quiet "Runs" button with a back
 * chevron that returns to the Runs page, since Live reads as Runs › Live.
 * It keeps the `tasks-back` test id every hosted page's back chip carries. */
export function RunsBackButton({ onBack }: { onBack: () => void }) {
  return (
    <Button
      variant="quiet"
      size="sm"
      data-testid="tasks-back"
      aria-label="Back to runs"
      icon={<ChevronLeft size={14} strokeWidth={1.8} aria-hidden />}
      onClick={onBack}
    >
      Runs
    </Button>
  );
}

/**
 * The Live page's head: the Runs back chip (when a host leads back) and the
 * h1 "Live", so it reads Runs › Live. It draws no breadcrumb trail of its
 * own: the topbar's trail already reads project / Runs / Live, with Runs a
 * link back and Live the current page (`currentShellPageTitle`).
 */
export function LivePageHead({ onBack }: { onBack?: () => void }) {
  return (
    <div className={styles.row}>
      {onBack === undefined ? null : <RunsBackButton onBack={onBack} />}
      <PageHead title={LIVE_PAGE_TITLE} titleLevel={1} />
    </div>
  );
}
