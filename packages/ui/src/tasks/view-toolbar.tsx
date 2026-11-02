'use client';

import type { ReactNode } from 'react';

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
   with replace while typing and push once at the end. `busy` marks the
   region aria-busy and draws a 2px accent progress rule under the bar
   while a view change loads. On a phone the search takes the first row
   and the controls scroll sideways on the second, so the page never
   scrolls horizontally. */
export function ViewToolbar({
  search,
  controls,
  end,
  busy = false,
  label = 'View options',
}: ViewToolbarProps): ReactNode {
  return (
    <div
      className={styles.bar}
      role="group"
      aria-label={label}
      aria-busy={busy ? 'true' : undefined}
      data-busy={busy ? 'true' : undefined}
    >
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
      <div className={styles.controls}>
        {controls}
        {end !== undefined && end !== null ? (
          <div className={styles.end}>{end}</div>
        ) : null}
      </div>
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
