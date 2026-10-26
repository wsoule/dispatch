'use client';

import {
  Fragment,
  memo,
  type NamedExoticComponent,
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
} from 'react';

import StatusMark from '../components/status-mark';
import { Link } from '../lib/link';
import { cx } from '../tasks/class-names';
import { formatDay } from './dates';
import { describeMilestone } from './describe';
import { applyOverrides } from './layout';
import styles from './timeline-cards.module.css';
import {
  barDueTone,
  laneSublabelTone,
  receiptsTone,
  undatedTone,
} from './tones';
import type { TimelineBar, TimelineGroup } from './types';

// The phone (≤ 900px) fallback, Gr8r's phone list: one bordered card per
// project, grouped under its initiative's heading, listing its milestones
// as rows (status mark, name, receipts, due date) in due-date order with
// the undated last. No drag here: re-dating needs the drawer's date field
// on a phone.

export interface TimelineCardsProps {
  groups: TimelineGroup[];
  today: string;
  /** Optimistic due dates by bar id. */
  overrides: ReadonlyMap<string, string>;
  selectedBarId?: string;
  focusLaneId?: string;
  onOpenBar: (barId: string) => void;
}

/** One line of receipts under a milestone name: status, progress, the
 * missing input, then the tags as small pills. A missing-input milestone
 * that carries its missing line says it once: the line names what is
 * missing, so the status label ("Missing input", "No issues yet") is left
 * out. The status word takes the line's tone, the missing input the
 * warning tone; the rest stays quiet. */
function CardReceipts({
  bar,
  loud,
}: {
  bar: TimelineBar;
  loud: boolean;
}): ReactElement {
  const tone = receiptsTone(bar, loud);
  const parts: ReactElement[] = [];
  if (!(bar.status === 'missing' && bar.missing !== undefined)) {
    parts.push(
      <span key="status" className={styles.rowStatus}>
        {bar.statusLabel}
      </span>
    );
  }
  if (bar.progressLabel !== undefined) {
    parts.push(<span key="progress">{bar.progressLabel}</span>);
  }
  if (bar.missing !== undefined) {
    parts.push(
      <span
        key="missing"
        className={styles.rowMissing}
        data-tone={loud ? 'warning' : 'default'}
      >
        {bar.missing}
      </span>
    );
  }
  const tags = bar.tags ?? [];
  return (
    <span
      className={cx(
        styles.rowMeta,
        tone === 'default' ? undefined : styles.rowMetaToned
      )}
      data-tone={tone}
    >
      {parts.map((part, i) => (
        <Fragment key={part.key}>
          {i > 0 ? ' · ' : null}
          {part}
        </Fragment>
      ))}
      {tags.map((tag) => (
        <span key={tag} className={styles.rowTag}>
          {tag}
        </span>
      ))}
    </span>
  );
}

function TimelineCardsImpl({
  groups,
  today,
  overrides,
  selectedBarId,
  focusLaneId,
  onOpenBar,
}: TimelineCardsProps): ReactElement {
  // The focused lane's card is scrolled into the page when the lane is
  // focused (first paint included), as the chart does for its lane row.
  // While the chart is showing, the cards are display: none and nothing
  // moves.
  const focusedCard = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = focusedCard.current;
    if (focusLaneId === undefined || el === null) return;
    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'start' });
    }
  }, [focusLaneId]);

  // Bars per lane with optimistic dates applied, sorted by due date.
  const sorted = useMemo(() => {
    const out = new Map<string, TimelineBar[]>();
    for (const group of groups) {
      for (const lane of group.lanes) {
        const bars = [...applyOverrides(lane.bars, overrides)];
        bars.sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
        out.set(lane.id, bars);
      }
    }
    return out;
  }, [groups, overrides]);

  return (
    <div className={styles.cards}>
      {groups.map((group) => (
        <section
          key={group.id}
          className={styles.group}
          aria-label={group.label}
        >
          <header className={styles.groupHead}>
            <h3 className={styles.groupName}>{group.label}</h3>
            <span className={styles.groupCount}>
              {group.lanes.length}{' '}
              {group.lanes.length === 1 ? 'project' : 'projects'}
            </span>
            {group.link !== undefined ? (
              <Link
                href={group.link.href}
                className={styles.groupLink}
                aria-label={group.link.ariaLabel}
              >
                {group.link.label}
              </Link>
            ) : null}
          </header>
          {group.lanes.map((lane) => {
            const bars = sorted.get(lane.id) ?? [];
            // An inactive lane is drawn in greys: no status hue in its
            // marks, receipts or dates, whatever its milestones' status.
            const loud = lane.muted !== true;
            const subTone = laneSublabelTone(lane);
            const noDateTone = undatedTone(loud);
            return (
              <article
                key={lane.id}
                ref={lane.id === focusLaneId ? focusedCard : undefined}
                data-lane-id={lane.id}
                className={cx(
                  styles.card,
                  lane.muted === true ? styles.cardMuted : undefined,
                  lane.id === focusLaneId ? styles.cardFocus : undefined
                )}
              >
                <header className={styles.cardHead}>
                  {lane.href !== undefined ? (
                    <Link href={lane.href} className={styles.cardName}>
                      {lane.label}
                    </Link>
                  ) : (
                    <span className={styles.cardName}>{lane.label}</span>
                  )}
                  {lane.sublabel !== undefined ? (
                    <span
                      className={cx(
                        styles.cardSub,
                        subTone === undefined ? undefined : styles.cardSubToned
                      )}
                      data-tone={subTone}
                    >
                      {lane.sublabel}
                    </span>
                  ) : null}
                </header>
                {bars.length === 0 && lane.undated.length === 0 ? (
                  <p className={styles.none}>No milestones</p>
                ) : (
                  <ul className={styles.rows}>
                    {bars.map((bar) => {
                      const dueTone = barDueTone(bar, loud);
                      return (
                        <li key={bar.id}>
                          <button
                            type="button"
                            className={cx(
                              styles.row,
                              bar.id === selectedBarId
                                ? styles.rowSelected
                                : undefined
                            )}
                            aria-label={describeMilestone(bar, today).join(
                              ', '
                            )}
                            aria-current={
                              bar.id === selectedBarId ? 'true' : undefined
                            }
                            onClick={() => onOpenBar(bar.id)}
                          >
                            <StatusMark
                              status={bar.status}
                              label={bar.statusLabel}
                              muted={!loud}
                            />
                            <span className={styles.rowBody}>
                              <span className={styles.rowName}>
                                {bar.label}
                              </span>
                              <CardReceipts bar={bar} loud={loud} />
                            </span>
                            <span
                              className={cx(
                                styles.rowDue,
                                dueTone === 'default'
                                  ? undefined
                                  : styles.rowDueToned
                              )}
                              data-tone={dueTone}
                            >
                              {formatDay(bar.end)}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                    {lane.undated.map((chip) => (
                      <li key={chip.id}>
                        <button
                          type="button"
                          className={cx(
                            styles.row,
                            chip.id === selectedBarId
                              ? styles.rowSelected
                              : undefined
                          )}
                          aria-label={`${chip.label}, ${chip.statusLabel}, no due date`}
                          aria-current={
                            chip.id === selectedBarId ? 'true' : undefined
                          }
                          onClick={() => onOpenBar(chip.id)}
                        >
                          <StatusMark
                            status="missing"
                            label="No date"
                            muted={!loud}
                          />
                          <span className={styles.rowBody}>
                            <span className={styles.rowName}>{chip.label}</span>
                            <span className={styles.rowMeta}>
                              {chip.statusLabel}
                            </span>
                          </span>
                          <span
                            className={cx(
                              styles.rowDue,
                              noDateTone === 'default'
                                ? undefined
                                : styles.rowDueToned
                            )}
                            data-tone={noDateTone}
                          >
                            No date
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            );
          })}
        </section>
      ))}
    </div>
  );
}

export const TimelineCards: NamedExoticComponent<TimelineCardsProps> =
  memo(TimelineCardsImpl);
