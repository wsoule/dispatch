'use client';

import { useState } from 'react';

import styles from './switch.module.css';
import type { SwitchProps } from './types';

/* Gr8r's toggle: a 30×18 track that turns the accent when on, its knob
   sliding across, beside a label (and an optional quiet note). The whole
   line is the control, role=switch with aria-checked, so Space/Enter and
   click toggle it natively. Its name is the visible label unless the host
   passes aria-label / aria-labelledby (a row that names the setting). */
export function Switch({
  checked,
  defaultChecked = false,
  onChange,
  label,
  note,
  disabled,
  id,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
}: SwitchProps) {
  const [inner, setInner] = useState(defaultChecked);
  const on = checked ?? inner;

  function toggle() {
    const next = !on;
    if (checked === undefined) setInner(next);
    onChange?.(next);
  }

  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={on}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      disabled={disabled}
      className={styles.switch}
      onClick={toggle}
    >
      <span className={styles.glyph} aria-hidden="true" />
      <span className={styles.label}>{label}</span>
      {note !== undefined && note !== '' ? (
        <span className={styles.note}>{note}</span>
      ) : null}
    </button>
  );
}
