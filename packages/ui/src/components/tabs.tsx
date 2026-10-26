'use client';

import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useId,
  useRef,
  useState,
} from 'react';

import styles from './tabs.module.css';

/* Client-side tab strip in Gr8r's tab-bar look: tabs on a hairline, the
   selected one in --text over a 2px --text underline, arrow-key roving focus. Element
   ids are prefixed per instance (useId), so two strips with the same item
   ids on one page keep their tab/panel pairs apart. */
export type TabItem = { id: string; label: string; content: ReactNode };

export interface TabsProps {
  items: TabItem[];
  /** The tablist's accessible name. */
  label?: string;
}

export default function Tabs({
  items,
  label = 'Sections',
}: TabsProps): ReactNode {
  const [chosen, setActive] = useState<string | null>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const prefix = useId();
  // The chosen tab while it still exists, else the first one.
  const active = items.some((t) => t.id === chosen)
    ? chosen
    : (items[0]?.id ?? null);

  const select = setActive;
  const tabId = (id: string) => `${prefix}tab-${id}`;
  const panelId = (id: string) => `${prefix}panel-${id}`;

  if (items.length === 0) return null;

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
    select(items[next].id);
    refs.current[next]?.focus();
  }

  return (
    <div className={`pageBlock ${styles.wrap}`}>
      <div
        role="tablist"
        aria-label={label}
        className={styles.tablist}
        style={{ '--tab-count': items.length } as CSSProperties}
      >
        {items.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={tabId(t.id)}
            aria-selected={t.id === active}
            aria-controls={panelId(t.id)}
            tabIndex={t.id === active ? 0 : -1}
            className={styles.tab}
            onClick={() => select(t.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {items.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={panelId(t.id)}
          aria-labelledby={tabId(t.id)}
          hidden={t.id !== active}
          className={styles.panel}
        >
          {t.content}
        </div>
      ))}
    </div>
  );
}
