import { Button, type DataAttributes } from '@dispatch/ui';
import { ChevronLeft } from 'lucide-react';
import type { ReactNode } from 'react';

import styles from './PageHead.module.css';

/** The props of PageHead, the head every main-column page leads with. */
export type PageHeadProps = {
  /** The page's heading. Omitted on a crumb-only head (a side page under
   * Tasks, a draft), where the crumb's last segment names the page. */
  title?: ReactNode;
  /** The heading's level: 1 for a page (default), 2 for a page hosted
   * inside another page that owns the h1. */
  titleLevel?: 1 | 2;
  /** Leads the head with the back chip to the Tasks list. */
  onBack?: () => void;
  /** Breadcrumb segments, joined by ›; the last one is the current page. */
  crumbs?: readonly ReactNode[];
  /** A quiet sentence beside the heading ("Nothing is written until…"). */
  meta?: ReactNode;
  /** The receipts line in tabular figures ("9 projects in 3 initiatives"). */
  receipts?: ReactNode;
  /** Right-aligned actions (a primary button, a toggle). */
  actions?: ReactNode;
} & DataAttributes;

/** The chip a page under Tasks leads with: a quiet "Tasks" button with a
 * back chevron that returns to the Tasks list. */
export function TasksBackButton({ onBack }: { onBack: () => void }) {
  return (
    <Button
      variant="quiet"
      size="sm"
      data-testid="tasks-back"
      aria-label="Back to tasks"
      icon={<ChevronLeft size={14} strokeWidth={1.8} aria-hidden />}
      onClick={onBack}
    >
      Tasks
    </Button>
  );
}

/**
 * The head of a main-column page (the Projects page's head made shared): the
 * optional back chip, the breadcrumb trail, the heading, a quiet meta
 * sentence, the receipts line and the actions pushed right. It places
 * nothing around itself; the host pads it. `data-slot="page-header"` on the
 * root and `data-slot="page-header-crumb"` on the trail are the hooks the
 * view tests read, and the trail's last segment carries aria-current.
 */
export function PageHead({
  title,
  titleLevel = 1,
  onBack,
  crumbs,
  meta,
  receipts,
  actions,
  ...data
}: PageHeadProps) {
  const Heading = titleLevel === 2 ? 'h2' : 'h1';
  return (
    <header {...data} data-slot="page-header" className={styles.head}>
      {onBack === undefined ? null : <TasksBackButton onBack={onBack} />}
      {crumbs !== undefined && crumbs.length > 0 ? (
        <Crumbs segments={crumbs} />
      ) : null}
      {title === undefined ? null : (
        <Heading className={styles.title}>{title}</Heading>
      )}
      {meta === undefined ? null : <span className={styles.meta}>{meta}</span>}
      {receipts === undefined ? null : (
        <p className={styles.receipts}>{receipts}</p>
      )}
      {actions === undefined ? null : (
        <div className={styles.actions}>{actions}</div>
      )}
    </header>
  );
}

// The breadcrumb trail: "Project › Drafts › Draft". Earlier segments are
// secondary text; the last is the page itself, marked aria-current.
function Crumbs({ segments }: { segments: readonly ReactNode[] }) {
  const last = segments.length - 1;
  return (
    <nav
      aria-label="Breadcrumb"
      data-slot="page-header-crumb"
      className={styles.crumbs}
    >
      <ol className={styles.trail}>
        {segments.map((segment, index) => (
          <li key={index} className={styles.segment}>
            {index > 0 ? (
              <span aria-hidden="true" className={styles.separator}>
                ›
              </span>
            ) : null}
            {index === last ? (
              <span aria-current="page" className={styles.current}>
                {segment}
              </span>
            ) : (
              <span className={styles.ancestor}>{segment}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
