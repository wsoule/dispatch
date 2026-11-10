'use client';

import { Plus } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';

import { cx } from '../tasks/class-names';
import { PickerPopover } from './picker-popover';
import styles from './picker-popover.module.css';
import { saveErrorMessage, useLatest } from './save-state';
import { editLabels } from './shared';
import type {
  PickerOption,
  TaskRelationPickerProps,
  TaskSearchResult,
} from './types';

/** The answer to one search, tagged with the request it answers, so a
    late answer to an older search is recognisably stale. */
interface SearchAnswer {
  request: string;
  results: readonly TaskSearchResult[];
  error: string | null;
}

const NO_RESULTS: readonly TaskSearchResult[] = [];

/**
 * "+ Add" for a relation section (Blocked by, Blocks): a PickerPopover
 * whose options come from the host's async `search` (by key or title),
 * run after a short pause in typing, with the stale request aborted. The
 * list shows a loading row while a search runs and an error row with
 * Retry when it fails; `exclude` keeps the task itself and tasks already
 * linked out of the results. Picking one calls `onSelect` (pending, then
 * rolled back with its error on rejection, like every edit control).
 */
export function TaskRelationPicker({
  label,
  search,
  onSelect,
  exclude,
  minQueryLength = 0,
  debounceMs = 200,
  trigger,
  searchPlaceholder = 'Search by key or title…',
  hintLabel,
  appearance = 'quiet',
  align = 'end',
  disabled,
  formatError,
  labels: labelOverrides,
  className,
}: TaskRelationPickerProps): ReactNode {
  const labels = editLabels(labelOverrides);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Bumped to run the current search again (Retry).
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<SearchAnswer | null>(null);
  const searchRef = useLatest(search);

  const term = query.trim();
  const tooShort = term.length < minQueryLength;
  const active = open && !tooShort;
  const request = `${attempt}:${term}`;
  const current = active && answer?.request === request ? answer : null;
  const loading = active && current === null;

  useEffect(() => {
    if (!active) return undefined;
    const controller = new AbortController();
    // The first search (empty, on open) and retries go at once; typing
    // waits for a pause.
    const delay = term === '' || attempt > 0 ? 0 : debounceMs;
    const timer = setTimeout(() => {
      searchRef.current(term, controller.signal).then(
        (results) => {
          if (controller.signal.aborted) return;
          setAnswer({ request, results, error: null });
        },
        (rejection: unknown) => {
          if (controller.signal.aborted) return;
          setAnswer({
            request,
            results: NO_RESULTS,
            error: saveErrorMessage(rejection, labels.saveFailed),
          });
        }
      );
    }, delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    active,
    term,
    attempt,
    request,
    debounceMs,
    searchRef,
    labels.saveFailed,
  ]);

  const onOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery('');
      setAttempt(0);
      setAnswer(null);
    }
  }, []);

  // While a newer search runs, the last answer stays on screen.
  const shownAnswer = active ? (current ?? answer) : null;
  const excluded = new Set(exclude ?? []);
  const results = (shownAnswer?.results ?? NO_RESULTS).filter(
    (task) => !excluded.has(task.id)
  );
  const byId = new Map(results.map((task) => [task.id, task]));
  const options: PickerOption[] = results.map((task) => ({
    value: task.id,
    label: task.title,
    hint: task.taskKey,
    keywords: [task.taskKey],
    group: task.group,
    mark:
      task.state !== undefined
        ? { kind: 'state', state: task.state.kind }
        : undefined,
  }));

  const face = trigger ?? (
    <span className={styles.face}>
      <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
      Add
    </span>
  );

  return (
    <PickerPopover
      label={label}
      triggerLabel={label}
      trigger={face}
      appearance={appearance}
      align={align}
      options={options}
      filter={false}
      query={query}
      onQueryChange={(next) => {
        setQuery(next);
        setAttempt(0);
      }}
      open={open}
      onOpenChange={onOpenChange}
      loading={loading}
      error={loading ? null : (current?.error ?? null)}
      onRetry={() => setAttempt((n) => n + 1)}
      emptyLabel={
        tooShort
          ? (hintLabel ?? `Type ${minQueryLength}+ characters`)
          : undefined
      }
      searchPlaceholder={searchPlaceholder}
      disabled={disabled}
      formatError={formatError}
      labels={labelOverrides}
      // Its hints are issue keys, printed in the mono id voice.
      className={cx(styles.keyHints, className)}
      value={null}
      action
      onChange={(id) => {
        const task = id === null ? undefined : byId.get(id);
        return task === undefined ? undefined : onSelect(task);
      }}
    />
  );
}
