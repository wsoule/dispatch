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
  /** Leads the head with the back chip to the Tasks list; shorthand for
   * `back={{ onBack }}`. Ignored when `back` is given. */
  onBack?: () => void;
  /** Leads the head with a back chip to the page's parent; its label, name
   * and test id default to the Tasks chip (see PageHeadBack). */
  back?: PageHeadBack;
  /** Breadcrumb segments, joined by ›; the last one is the current page. */
  crumbs?: readonly ReactNode[];
  /** A quiet sentence beside the heading ("Nothing is written until…"). */
  meta?: ReactNode;
  /** The receipts line in tabular figures ("9 projects in 3 initiatives"). */
  receipts?: ReactNode;
  /** Right-aligned actions (a primary button, a toggle). */
  actions?: ReactNode;
} & DataAttributes;

/** The back chip a page leads with. Every field but `onBack` defaults to
 * the Tasks chip: label "Tasks", accessible name "Back to tasks", test id
 * `tasks-back`. A page under another parent names that parent instead
 * (Live, under Runs, passes RUNS_BACK). */
export type PageHeadBack = {
  /** What the chip shows: the parent page's name ("Tasks", "Runs"). */
  label?: string;
  /** The chip's accessible name ("Back to tasks"). */
  name?: string;
  /** Returns to the parent page. */
  onBack: () => void;
  /** The chip's data-testid; every hosted page keeps `tasks-back`. */
  testId?: string;
};

/** The back chip of a page under Runs (Live): it reads Runs › Live. */
export const RUNS_BACK = { label: 'Runs', name: 'Back to runs' } as const;

/** A page's back chip: a quiet button with a back chevron that returns to
 * the parent page, by default the Tasks list. */
export function BackChip({
  label = 'Tasks',
  name = 'Back to tasks',
  onBack,
  testId = 'tasks-back',
}: PageHeadBack) {
  return (
    <Button
      variant="quiet"
      size="sm"
      data-testid={testId}
      aria-label={name}
      icon={<ChevronLeft size={14} strokeWidth={1.8} aria-hidden />}
      onClick={onBack}
    >
      {label}
    </Button>
  );
}

/** The chip a page under Tasks leads with: a quiet "Tasks" button with a
 * back chevron that returns to the Tasks list. */
export function TasksBackButton({ onBack }: { onBack: () => void }) {
  return <BackChip onBack={onBack} />;
}

/**
 * The head of a main-column page (the Projects page's head made shared): the
 * optional back chip (`back`, or `onBack` for the Tasks chip), the breadcrumb trail, the heading, a quiet meta
 * sentence, the receipts line and the actions pushed right. It places
 * nothing around itself; the host pads it. `data-slot="page-header"` on the
 * root and `data-slot="page-header-crumb"` on the trail are the hooks the
 * view tests read, and the trail's last segment carries aria-current.
 */
export function PageHead({
  title,
  titleLevel = 1,
  onBack,
  back,
  crumbs,
  meta,
  receipts,
  actions,
  ...data
}: PageHeadProps) {
  const Heading = titleLevel === 2 ? 'h2' : 'h1';
  const chip = back ?? (onBack === undefined ? undefined : { onBack });
  return (
    <header {...data} data-slot="page-header" className={styles.head}>
      {chip === undefined ? null : <BackChip {...chip} />}
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
