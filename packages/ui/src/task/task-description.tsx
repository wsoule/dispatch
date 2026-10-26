'use client';

import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';

import { SkeletonText } from '../shell/skeleton';
import { cx } from '../tasks/class-names';
import { DEFAULT_TASK_LABELS } from './shared';
import styles from './task-description.module.css';
import type { TaskDescriptionProps } from './types';

// Characters per rendered line assumed before the browser can measure: a
// 512px drawer column at 13.5px holds roughly this many.
const CHARS_PER_LINE = 72;

/** Normalises line endings and drops blank lines at either end, keeping
    every line break and indent in between. */
function normalise(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+|\s+$/g, '');
}

/**
 * A first guess at whether `text` runs past `lines` lines, used for the
 * server render and the first paint: hard line breaks plus long lines
 * wrapped at CHARS_PER_LINE. The browser replaces it with a measurement.
 */
export function likelyOverflows(text: string, lines: number): boolean {
  let count = 0;
  for (const line of text.split('\n')) {
    count += Math.max(1, Math.ceil(line.length / CHARS_PER_LINE));
    if (count > lines) return true;
  }
  return false;
}

/**
 * The task's description as plain text: line breaks kept, nothing parsed
 * (markdown shows as typed, markup as text), so a description can never
 * inject HTML. Long text is clamped to `clampLines` lines with a Show more
 * button (aria-expanded) that only appears when the text really is longer.
 * Loading shows skeleton lines, an error shows one line with an
 * optional retry, and blank text says "No description". Each paragraph
 * takes its own direction, so a right-to-left line reads right to left.
 * A host that renders the description itself passes `content` instead.
 */
export function TaskDescription({
  text,
  content,
  loading = false,
  error = null,
  sourceLabel,
  onRetry,
  clampLines = 12,
  defaultExpanded = false,
  emptyLabel = DEFAULT_TASK_LABELS.noDescription,
  loadingLabel = DEFAULT_TASK_LABELS.loadingDescription,
  errorLabel = DEFAULT_TASK_LABELS.error,
  retryLabel = DEFAULT_TASK_LABELS.retry,
  showMoreLabel = DEFAULT_TASK_LABELS.showMore,
  showLessLabel = DEFAULT_TASK_LABELS.showLess,
}: TaskDescriptionProps): ReactNode {
  const body = text === null ? '' : normalise(text);
  const textId = useId();
  const textRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(defaultExpanded);
  // null until the browser has measured; the guess holds until then (and
  // wherever there is no layout, e.g. a test DOM).
  const [measured, setMeasured] = useState<boolean | null>(null);
  const overflows = measured ?? likelyOverflows(body, clampLines);

  // Measures the full text against the clamp height (scrollHeight counts
  // the clipped lines too, so this works collapsed or expanded) and again
  // whenever the column width changes.
  useEffect(() => {
    const el = textRef.current;
    if (el === null) return undefined;
    function measure() {
      if (el === null) return;
      const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight);
      if (el.scrollHeight === 0 || !Number.isFinite(lineHeight)) return;
      setMeasured(el.scrollHeight > lineHeight * clampLines + 1);
    }
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [body, clampLines, loading, error]);

  if (loading) {
    return (
      <div className={styles.wrap}>
        <SkeletonText lines={4} label={loadingLabel} />
      </div>
    );
  }

  if (error !== null && error !== undefined && error !== '') {
    return (
      <div className={styles.error} role="alert">
        <span className={styles.errorKey}>{errorLabel}</span>
        <p className={styles.errorText}>
          {error}
          {onRetry !== undefined ? (
            <>
              {' '}
              <button type="button" className={styles.retry} onClick={onRetry}>
                {retryLabel}
              </button>
            </>
          ) : null}
        </p>
      </div>
    );
  }

  const footer =
    sourceLabel !== undefined && sourceLabel !== '' ? (
      <p className={styles.source}>{sourceLabel}</p>
    ) : null;

  // The host's own rendering (markdown, an editor) stands in for the text.
  if (content !== undefined && content !== null && content !== false) {
    return (
      <div className={styles.wrap}>
        <div className={styles.content}>{content}</div>
        {footer !== null ? <div className={styles.foot}>{footer}</div> : null}
      </div>
    );
  }

  if (body === '') {
    return (
      <div className={styles.wrap}>
        <p className={styles.empty}>{emptyLabel}</p>
        {footer}
      </div>
    );
  }

  const clamped = overflows && !expanded;
  const style = { '--clamp-lines': clampLines } as CSSProperties;
  return (
    <div className={styles.wrap}>
      <div
        ref={textRef}
        id={textId}
        className={cx(styles.text, clamped ? styles.clamped : undefined)}
        data-clamped={clamped ? 'true' : undefined}
        style={style}
      >
        {body}
      </div>
      {overflows || footer !== null ? (
        <div className={styles.foot}>
          {overflows ? (
            <button
              type="button"
              className={styles.toggle}
              aria-expanded={expanded}
              aria-controls={textId}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? showLessLabel : showMoreLabel}
            </button>
          ) : null}
          {footer}
        </div>
      ) : null}
    </div>
  );
}
