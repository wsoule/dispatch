'use client';

import { type ReactNode, useId } from 'react';

import { dataAttributes } from '../lib/data-attributes';
import styles from './radio-group.module.css';
import type { RadioGroupProps } from './types';

/* Exclusive choices as native radios (visually hidden), so the browser's
   arrow keys move and pick; an option's hint describes it. A host's data-*
   hooks land on the radiogroup. */
export function RadioGroup(props: RadioGroupProps): ReactNode {
  const {
    options,
    value,
    onChange,
    label,
    'aria-labelledby': labelledBy,
    orientation = 'vertical',
    disabled = false,
  } = props;
  const name = useId();
  return (
    <div
      {...dataAttributes(props)}
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-orientation={orientation}
      aria-disabled={disabled ? true : undefined}
      className={styles.group}
      data-orientation={orientation}
    >
      {options.map((option) => {
        const hintId = `${name}-${option.value}-hint`;
        const hasHint =
          option.hint !== undefined &&
          option.hint !== null &&
          option.hint !== false;
        const off = disabled || option.disabled === true;
        return (
          <div key={option.value} className={styles.option}>
            <label
              className={styles.row}
              data-disabled={off ? 'true' : undefined}
            >
              <input
                type="radio"
                className={styles.input}
                name={name}
                value={option.value}
                checked={value === option.value}
                disabled={off}
                aria-describedby={hasHint ? hintId : undefined}
                onChange={() => onChange(option.value)}
              />
              <span className={styles.ring} aria-hidden="true" />
              <span className={styles.label}>{option.label}</span>
            </label>
            {hasHint ? (
              <span id={hintId} className={styles.hint}>
                {option.hint}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
