'use client';

import type { ReactNode } from 'react';

import { cx } from './class-names';
import { SearchField } from './search-field';
import type { ViewToolbarProps } from './types';
import styles from './view-toolbar.module.css';

/* Gr8r's list toolbar (.toolbar in view-engine.js): a small search field,
   then the host's Filter / Sort / Group triggers, and trailing actions at
   the right edge. Layout only: the host owns every value and picker.

   The search is a SearchField at size sm with no clear button of its own
   (the browser's stays) and Escape left to the browser. It reports each
   keystroke (onChange) and, separately, when the search is final
   (onCommit: Enter, or leaving the field), so a host can update a URL
   with replace while typing and push once at the end. Without `search`
   (a page scanned down a column, such as Runs or Usage) there is no
   field at all: the controls start at the left edge and `end` still
   takes the right one. `busy` marks the region aria-busy and draws a 2px
   accent progress rule under the bar while a view change loads. On a
   phone the search takes the first row and the controls scroll sideways
   on the second, the end actions with them, so the page never scrolls
   horizontally. Without a search the end actions are the bar's own cell
   beside the controls rather than inside them: they wrap under the
   controls when the row is too narrow for both, and on a phone they
   always take a row of their own, so the controls' sideways scroll (which
   draws no scrollbar) never hides them. */
export function ViewToolbar({
  search,
  controls,
  end,
  busy = false,
  label = 'View options',
}: ViewToolbarProps): ReactNode {
  const endCell =
    end !== undefined && end !== null ? (
      <div className={styles.end}>{end}</div>
    ) : null;
  return (
    <div
      className={cx(styles.bar, search === undefined && styles.noSearch)}
      role="group"
      aria-label={label}
      aria-busy={busy ? 'true' : undefined}
      data-busy={busy ? 'true' : undefined}
    >
      {search !== undefined ? (
        <div className={styles.search}>
          <SearchField
            size="sm"
            clearable={false}
            escapeClears={false}
            value={search.value}
            onChange={search.onChange}
            onCommit={search.onCommit}
            placeholder={search.placeholder}
            label={search.label}
            inputRef={search.inputRef}
          />
        </div>
      ) : null}
      <div className={styles.controls}>
        {controls}
        {search !== undefined ? endCell : null}
      </div>
      {search === undefined ? endCell : null}
      {busy ? <span className={styles.progress} aria-hidden="true" /> : null}
    </div>
  );
}

/** The accent count pill of a toolbar trigger ("Filter 2"): how many
    fields are set. Decorative beside the trigger's own accessible name,
    which should say the count in words ("Filter, 2 set"). */
export function ToolbarBadge({ count }: { count: number }): ReactNode {
  return (
    <span className={styles.badge} aria-hidden="true">
      {count}
    </span>
  );
}
