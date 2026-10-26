'use client';

import { type KeyboardEvent, useRef, useState } from 'react';

import { cx } from './class-names';
import styles from './segmented-control.module.css';
import type { SegmentedControlProps } from './types';

/* Gr8r's segmented toggle (List / Calendar, Weeks / Months): a recessed
   track whose selected option is a raised white thumb ringed in the
   accent. Semantics are a radio group with a
   roving tabindex: Tab enters on the selected option, arrows move AND
   select (radio behaviour), Home/End jump, disabled options are skipped. */
export function SegmentedControl({
  options,
  value,
  defaultValue,
  onChange,
  label,
  size = 'md',
  fill = false,
}: SegmentedControlProps) {
  const [inner, setInner] = useState(defaultValue ?? options[0]?.id ?? '');
  const selected = value ?? inner;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function select(id: string) {
    if (value === undefined) setInner(id);
    if (id !== selected) onChange?.(id);
  }

  // Next enabled option from `from` in direction `step`, wrapping; returns
  // `from` itself when every other option is disabled.
  function nextEnabled(from: number, step: 1 | -1): number {
    const n = options.length;
    for (let k = 1; k <= n; k++) {
      const i = (from + step * k + n) % n;
      if (options[i]?.disabled !== true) return i;
    }
    return from;
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number | undefined;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = nextEnabled(index, 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = nextEnabled(index, -1);
        break;
      case 'Home':
        next = nextEnabled(-1, 1);
        break;
      case 'End':
        next = nextEnabled(options.length, -1);
        break;
      default:
        return;
    }
    event.preventDefault();
    const option = options[next];
    if (option === undefined) return;
    select(option.id);
    refs.current[next]?.focus();
  }

  // The selected option owns the tab stop; if it is missing or disabled the
  // first enabled option does, so the group is always reachable.
  const selectedIndex = options.findIndex(
    (o) => o.id === selected && o.disabled !== true
  );
  const tabIndexOwner = selectedIndex >= 0 ? selectedIndex : nextEnabled(-1, 1);

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx(styles.group, styles[size], fill ? styles.fill : undefined)}
    >
      {options.map((option, i) => {
        const checked = option.id === selected;
        return (
          <button
            key={option.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={option.disabled}
            tabIndex={i === tabIndexOwner ? 0 : -1}
            className={styles.option}
            onClick={() => select(option.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            <span>{option.label}</span>
            {option.count !== undefined ? (
              <span className={styles.count}>{option.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
