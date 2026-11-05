'use client';

import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useId,
  useRef,
  useState,
} from 'react';

import { dataAttributes } from '../lib/data-attributes';
import type { DataAttributes } from '../types';
import styles from './tabs.module.css';

/* Client-side tab strip in Gr8r's tab-bar look: tabs on a hairline, the
   selected one in --text over a 2px --text underline, arrow-key roving focus. Element
   ids are prefixed per instance (useId), so two strips with the same item
   ids on one page keep their tab/panel pairs apart. The strip is
   uncontrolled by default; with `value` the host owns the selection and
   hears every pick through `onChange`. An item without `content` shows the
   host's own panel (`children`), so a host can keep one panel mounted
   across tabs and still get the tab/tabpanel id pairing. */
export type TabItem = {
  id: string;
  label: string;
  /** This tab's own panel, mounted and hidden while another tab is
      selected. Leave it out to show the strip's `children` while this tab
      is selected. */
  content?: ReactNode;
};

export interface TabsProps extends DataAttributes {
  items: TabItem[];
  /** The tablist's accessible name. */
  label?: string;
  /** The selected tab's id. Set, the strip is controlled: a pick only
      calls `onChange`, and the selection moves when the host passes the
      new id. An id that names no item selects the first tab. */
  value?: string;
  /** Called with a tab's id when a click, an arrow key, Home or End picks
      a tab other than the selected one (controlled or not). */
  onChange?: (id: string) => void;
  /** The host's panel: the tabpanel of a selected tab whose item has no
      `content`, labelled by that tab. Not rendered while the selected
      tab has its own content. */
  children?: ReactNode;
  /** Leaves out the page column (`.pageBlock`: its max width, top margin
      and gutter) and the strip's bottom margin, for a strip inside a pane
      that already sets its own width and gutter. */
  flush?: boolean;
}

export default function Tabs(props: TabsProps): ReactNode {
  const {
    items,
    label = 'Sections',
    value,
    onChange,
    children,
    flush = false,
  } = props;
  const [chosen, setChosen] = useState<string | null>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const prefix = useId();
  const controlled = value !== undefined;
  const wanted = controlled ? value : chosen;
  // The wanted tab while it still exists, else the first one.
  const active = items.find((t) => t.id === wanted) ?? items[0];

  const tabId = (id: string) => `${prefix}tab-${id}`;
  const panelId = (id: string) => `${prefix}panel-${id}`;

  if (active === undefined) return null;
  const activeId = active.id;

  // Picks the tab at index i: reports it when it is not already selected,
  // keeps it as the selection only while uncontrolled (a controlled strip
  // waits for the host's new `value`), and focuses it, since WebKit does
  // not focus a clicked button by itself.
  function pick(i: number) {
    const tab = items[i];
    if (tab === undefined) return;
    if (!controlled) setChosen(tab.id);
    if (tab.id !== activeId) onChange?.(tab.id);
    refs.current[i]?.focus();
  }

  function onKey(e: KeyboardEvent, i: number) {
    const n = items.length;
    const next = {
      ArrowRight: (i + 1) % n,
      ArrowLeft: (i - 1 + n) % n,
      Home: 0,
      End: n - 1,
    }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    pick(next);
  }

  return (
    <div
      {...dataAttributes(props)}
      className={flush ? styles.flush : `pageBlock ${styles.wrap}`}
    >
      <div
        role="tablist"
        aria-label={label}
        className={styles.tablist}
        style={{ '--tab-count': items.length } as CSSProperties}
      >
        {items.map((t, i) => {
          const selected = t.id === activeId;
          // A tab with its own content controls its own panel. One without
          // controls the host's panel, which exists only while it is
          // selected, so an unselected one names no panel.
          const controls =
            t.content !== undefined || selected ? panelId(t.id) : undefined;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={tabId(t.id)}
              aria-selected={selected}
              aria-controls={controls}
              tabIndex={selected ? 0 : -1}
              className={styles.tab}
              onClick={() => pick(i)}
              onKeyDown={(e) => onKey(e, i)}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {items.map((t) =>
        t.content === undefined ? null : (
          <div
            key={t.id}
            role="tabpanel"
            id={panelId(t.id)}
            aria-labelledby={tabId(t.id)}
            hidden={t.id !== activeId}
            className={styles.panel}
          >
            {t.content}
          </div>
        )
      )}
      {active.content === undefined && (
        <div
          role="tabpanel"
          id={panelId(activeId)}
          aria-labelledby={tabId(activeId)}
          className={styles.panel}
        >
          {children}
        </div>
      )}
    </div>
  );
}
