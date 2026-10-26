'use client';

import { useEffect, useRef, useState } from 'react';

import styles from './checkbox.module.css';
import type { CheckboxProps } from './types';

/* Gr8r's checkbox: the native input (kept for forms, focus and assistive
   tech, visually hidden) drives a 15px rounded box that fills the accent
   with a drawn tick when on, beside its label. The whole line is the
   <label>, so clicking the text toggles it. Use it for set membership
   ("who are the watchers"); Switch is for a mode that is on or off.
   `indeterminate` draws the mixed state (a group of rows partly
   selected): the accent box with a dash. The native property is set
   after each render, since a click clears it, and aria-checked="mixed"
   says so before hydration. */
export function Checkbox({
  checked,
  defaultChecked = false,
  onChange,
  label,
  note,
  disabled,
  id,
  name,
  value,
  hideLabel = false,
  'aria-label': ariaLabel,
  indeterminate = false,
}: CheckboxProps) {
  const [inner, setInner] = useState(defaultChecked);
  const on = checked ?? inner;
  const inputRef = useRef<HTMLInputElement>(null);
  const mixed = indeterminate && !on;

  // No dependency list on purpose: a click clears the native flag, and the
  // prop may not change after it (a host that refused the change).
  useEffect(() => {
    if (inputRef.current !== null) inputRef.current.indeterminate = mixed;
  });

  return (
    <label className={styles.checkbox} data-disabled={disabled === true}>
      <input
        ref={inputRef}
        type="checkbox"
        className={styles.input}
        id={id}
        name={name}
        value={value}
        checked={on}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-checked={mixed ? 'mixed' : undefined}
        onChange={(event) => {
          const next = event.target.checked;
          if (checked === undefined) setInner(next);
          onChange?.(next);
        }}
      />
      <span
        className={styles.glyph}
        aria-hidden="true"
        data-mixed={mixed ? 'true' : undefined}
      >
        <svg viewBox="0 0 13 13" className={styles.check}>
          <path d={mixed ? 'M3.5 6.5h6' : 'M3 6.6 5.4 9 10 4'} />
        </svg>
      </span>
      <span className={hideLabel ? 'srOnly' : styles.label}>{label}</span>
      {note !== undefined && note !== '' ? (
        <span className={styles.note}>{note}</span>
      ) : null}
    </label>
  );
}
