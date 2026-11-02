import type {
  MergeQueueEntry,
  MilestoneProgress,
  RunMeta,
} from '@dispatch/client';
import { Button, cx, ListItem, SectionHeader } from '@dispatch/ui';
import { CirclePause } from 'lucide-react';
import {
  createContext,
  Fragment,
  type ReactNode,
  useContext,
  useState,
} from 'react';

import { useRunStep } from '../../hooks/useRunStep';
import { type FlowRow, useFlowRows } from '../../lib/flowList';
import type { GlossaryKey } from '../../lib/glossary';
import { type LiveCeilings, liveCeilingsLabel } from '../../lib/liveSpend';
import { formatUsd, spendPillLabel } from '../../lib/milestoneSession';
import { isTerminalRunState } from '../../lib/runState';
import { GlossaryTerm } from '../guide/GlossaryTerm';
import { StateMark } from '../status/StateMark';
import styles from './FlowColumns.module.css';

/** Three chevrons pointing the way things move; they march while anything
    flows (only under no-preference motion; brighter but still otherwise). */
function FlowChevrons({ active }: { active: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={styles.chevrons}
      data-active={active ? 'true' : undefined}
    >
      <span className={styles.chevron}>›</span>
      <span className={styles.chevron}>›</span>
      <span className={styles.chevron}>›</span>
    </span>
  );
}

// True inside a narrow window's sheet: the column fills the sheet instead of
// sitting beside the stream once the Overseer is wide enough.
const InSheet = createContext(false);

/** Renders a column full-width inside a sheet, for a narrow Overseer. The
    SlideOver's title (SheetTitle) is the column's name and count there, so
    the column draws no head of its own and its groups stay h3 under that h2. */
export function ColumnInSheet({ children }: { children: ReactNode }) {
  return <InSheet.Provider value>{children}</InSheet.Provider>;
}

const COLUMN_NAMES = {
  in: { label: 'Coming in', term: 'comingIn' },
  out: { label: 'Going out', term: 'goingOut' },
} as const satisfies Record<string, { label: string; term: GlossaryKey }>;

/** A column's name (its glossary term) and count, as one heading's text: the
    column head beside the talk, and the SlideOver's title for the sheet, so
    the sheet names the column once ("Going out 3"), not twice. */
export function SheetTitle({
  column,
  count,
}: {
  column: 'in' | 'out';
  count: number;
}) {
  const { label, term } = COLUMN_NAMES[column];
  return (
    <>
      <GlossaryTerm term={term}>{label}</GlossaryTerm>{' '}
      <span className={styles.titleCount}>{count}</span>
    </>
  );
}

/** A column: the head (its name and count in one heading, the chevrons
    after it) pinned on top, the rest scrolling under it. Beside the talk it
    shows only on a wide Overseer (the module's container query); in a sheet
    it always shows, fills the sheet, and leaves its name to the sheet's
    title. */
function Column({
  label,
  term,
  count,
  testId,
  sub,
  children,
}: {
  label: string;
  count: number;
  testId: string;
  term?: GlossaryKey;
  /** A quiet line under the head, e.g. what the work is costing. */
  sub?: ReactNode;
  children: ReactNode;
}) {
  const inSheet = useContext(InSheet);
  return (
    <aside
      aria-label={label}
      data-testid={inSheet ? `${testId}-sheet` : testId}
      className={inSheet ? styles.sheetColumn : styles.column}
    >
      {/* Both point right: in travels toward the talk, out travels away from it. */}
      {!inSheet && (
        <SectionHeader
          as="h2"
          className={styles.head}
          name={
            term === undefined ? (
              label
            ) : (
              <GlossaryTerm term={term}>{label}</GlossaryTerm>
            )
          }
          count={count}
          actions={<FlowChevrons active={count > 0} />}
        />
      )}
      {sub}
      <div className={styles.scroll}>
        <div className={styles.stack}>{children}</div>
      </div>
    </aside>
  );
}

/** The quiet line a column shows when nothing is in it. */
function EmptyLine({ children }: { children: ReactNode }) {
  return <p className={styles.empty}>{children}</p>;
}

/** What is coming to you: the asks and the "For you" posts, entering from the left. */
export function InflowColumn({
  count,
  children,
}: {
  count: number;
  children: ReactNode;
}) {
  return (
    <Column
      label={COLUMN_NAMES.in.label}
      term={COLUMN_NAMES.in.term}
      count={count}
      testId="overseer-inflow"
    >
      {count === 0 && <EmptyLine>Nothing is waiting on you.</EmptyLine>}
      <div className={cx(styles.inflow, styles.enterLeft)}>{children}</div>
    </Column>
  );
}

const LANDING: ReadonlySet<MergeQueueEntry['state']> = new Set([
  'queued',
  'waiting-blockers',
  'blocked-environment',
  'waiting-github',
  'rebasing',
  'verifying',
  'merging',
]);

/** The runs Going out lists as running: live execute runs. */
function liveRunsOf(runs: readonly RunMeta[]): RunMeta[] {
  return runs.filter(
    (r) => !isTerminalRunState(r.state) && (r.kind ?? 'execute') === 'execute'
  );
}

/** The merge queue entries Going out lists as landing. */
function landingOf(merges: readonly MergeQueueEntry[]): MergeQueueEntry[] {
  return merges.filter((m) => LANDING.has(m.state));
}

/** How many things Going out holds (sessions, running, landing, set aside):
    its head's count, and the sheet's title count (SheetTitle). */
export function outflowCount({
  runs,
  merges,
  sessions = [],
  setAside,
}: {
  runs: readonly RunMeta[];
  merges: readonly MergeQueueEntry[];
  sessions?: readonly MilestoneProgress[];
  setAside: number;
}): number {
  return (
    sessions.length +
    liveRunsOf(runs).length +
    landingOf(merges).length +
    setAside
  );
}

/** What a Going out row takes for its motion: the class that slides it in
    from the right, and `data-leaving` while it slides back out (the module
    runs both only under no-preference motion). */
interface RowMotion {
  className: string;
  'data-leaving': 'true' | undefined;
}

/** One live run: its task, and the step it is on right now. */
function RunRow({
  run,
  onOpen,
  motion,
}: {
  run: RunMeta;
  onOpen: () => void;
  motion: RowMotion;
}) {
  const step = useRunStep(run.id);
  return (
    <ListItem
      {...motion}
      role="listitem"
      onClick={onOpen}
      // The live dot: blue (in progress) through the tone hook, pulsing only
      // under no-preference motion; the crumb says the state in words.
      leading={
        <span aria-hidden="true" data-tone="info" className={styles.liveDot} />
      }
      title={run.taskTitle}
      crumb={
        run.state === 'awaiting-approval'
          ? 'waiting on approval'
          : (step ?? run.state)
      }
    />
  );
}

/** Draws flow rows, handing each its motion: entering rows slide in from
    the right edge, leaving rows slide out to it and stop taking clicks. */
function Rows<T>({
  rows,
  render,
}: {
  rows: FlowRow<T>[];
  render: (item: T, motion: RowMotion) => ReactNode;
}) {
  return rows.map((row) => (
    <Fragment key={row.key}>
      {render(row.item, {
        className: cx(styles.row, styles.enterRight),
        'data-leaving': row.leaving ? 'true' : undefined,
      })}
    </Fragment>
  ));
}

/** Today's spend and the live milestones against their ceilings, in one line. */
export function spendLine(
  today: number | null,
  ceilings: LiveCeilings | null
): string | null {
  const parts: string[] = [];
  if (today !== null && today > 0) parts.push(`${formatUsd(today)} today`);
  if (ceilings !== null && ceilings.live > 0) {
    parts.push(liveCeilingsLabel(ceilings));
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

/** One live milestone session: its title, how many of its runs are live, and its spend. */
function SessionRow({
  progress,
  title,
  onOpen,
  motion,
}: {
  progress: MilestoneProgress;
  title: string;
  onOpen: () => void;
  motion: RowMotion;
}) {
  const live = progress.liveRuns.length;
  const paused = progress.session?.state === 'paused';
  return (
    <ListItem
      {...motion}
      role="listitem"
      data-testid="overseer-session-row"
      onClick={onOpen}
      // A paused session still drains its last runs; held, not working. Paused
      // is grey in the status table (amber is for blocked), so it takes a
      // pause glyph in the muted tone rather than the blocked mark.
      leading={
        paused ? (
          <CirclePause
            size={14}
            strokeWidth={1.8}
            aria-hidden
            data-slot="state-mark"
            data-state="paused"
            data-tone="muted"
            className={styles.pausedMark}
          />
        ) : (
          <StateMark state="working" pulse />
        )
      }
      title={title}
      crumb={paused ? 'paused' : `${live} running`}
      date={spendPillLabel(progress.spend)}
    />
  );
}

/** What Going out shows beyond runs and merges, handed through from App. */
export interface OutflowExtras {
  /** Milestones with an active or paused fan-out session. */
  sessions?: readonly MilestoneProgress[];
  /** A milestone's title by id. */
  milestoneTitle?: (milestoneId: string) => string;
  /** Finished runs "Merge all ready" would queue. */
  mergeReady?: number;
  onMergeAll?: () => Promise<void>;
  /** Settled spend across today's runs; `null` or zero shows nothing. */
  spendToday?: number | null;
  /** The live sessions' spend against their ceilings, summed. */
  ceilings?: LiveCeilings | null;
}

interface OutflowColumnProps extends OutflowExtras {
  runs: readonly RunMeta[];
  merges: readonly MergeQueueEntry[];
  setAside: ReactNode[];
  onOpenTask: (taskId: string) => void;
}

/**
 * What is leaving your hands: live milestone sessions, live runs, merges
 * landing and set-aside conversations. New work slides in; finished work
 * slides out to the right. The head carries today's spend, and Landing offers
 * "Merge all ready" while finished work waits to be queued.
 */
export function OutflowColumn({
  runs,
  merges,
  setAside,
  onOpenTask,
  sessions = [],
  milestoneTitle = (id) => id,
  mergeReady = 0,
  onMergeAll,
  spendToday = null,
  ceilings = null,
}: OutflowColumnProps) {
  const [merging, setMerging] = useState(false);
  const live = liveRunsOf(runs);
  const landing = landingOf(merges);
  const liveRows = useFlowRows(live, (r) => r.id);
  const landingRows = useFlowRows(landing, (m) => m.runId);
  const sessionRows = useFlowRows(sessions, (p) => p.milestoneId);
  const count =
    sessions.length + live.length + landing.length + setAside.length;
  const canMergeAll = onMergeAll !== undefined && mergeReady > 0;
  const spend = spendLine(spendToday, ceilings);
  const mergeAll = () => {
    if (onMergeAll === undefined) return;
    setMerging(true);
    void onMergeAll().finally(() => setMerging(false));
  };
  return (
    <Column
      label={COLUMN_NAMES.out.label}
      term={COLUMN_NAMES.out.term}
      count={count}
      testId="overseer-outflow"
      sub={
        spend !== null && (
          <p
            data-testid="overseer-spend"
            className={styles.spend}
            title={spend}
          >
            {spend}
          </p>
        )
      }
    >
      {count === 0 &&
        liveRows.length === 0 &&
        landingRows.length === 0 &&
        sessionRows.length === 0 &&
        !canMergeAll && <EmptyLine>Nothing is running.</EmptyLine>}
      {sessionRows.length > 0 && (
        <section className={styles.group}>
          <SectionHeader
            as="h3"
            className={styles.groupHead}
            name={<GlossaryTerm term="milestone">Milestones</GlossaryTerm>}
          />
          <div role="list" className={styles.list}>
            <Rows
              rows={sessionRows}
              render={(progress, motion) => (
                <SessionRow
                  progress={progress}
                  motion={motion}
                  title={milestoneTitle(progress.milestoneId)}
                  onOpen={() => onOpenTask(progress.milestoneId)}
                />
              )}
            />
          </div>
        </section>
      )}
      {liveRows.length > 0 && (
        <section className={styles.group}>
          <SectionHeader as="h3" className={styles.groupHead} name="Running" />
          <div role="list" className={styles.list}>
            <Rows
              rows={liveRows}
              render={(run, motion) => (
                <RunRow
                  run={run}
                  motion={motion}
                  onOpen={() => onOpenTask(run.taskId)}
                />
              )}
            />
          </div>
        </section>
      )}
      {(landingRows.length > 0 || canMergeAll) && (
        <section className={styles.group}>
          <SectionHeader
            as="h3"
            className={styles.groupHead}
            name={<GlossaryTerm term="mergeQueue">Landing</GlossaryTerm>}
            actions={
              canMergeAll && (
                <Button
                  variant="quiet"
                  size="sm"
                  disabled={merging}
                  onClick={mergeAll}
                  data-testid="overseer-merge-all"
                >
                  Merge all ready ({mergeReady})
                </Button>
              )
            }
          />
          <div role="list" className={styles.list}>
            <Rows
              rows={landingRows}
              render={(entry, motion) => (
                <ListItem
                  {...motion}
                  role="listitem"
                  onClick={() => onOpenTask(entry.taskId)}
                  title={entry.taskTitle}
                  date={entry.state.replace('-', ' ')}
                />
              )}
            />
          </div>
        </section>
      )}
      {setAside.length > 0 && (
        <section className={styles.group}>
          <SectionHeader
            as="h3"
            className={styles.groupHead}
            name="Set aside"
          />
          <div role="list" className={cx(styles.list, styles.setAside)}>
            {setAside}
          </div>
        </section>
      )}
    </Column>
  );
}
