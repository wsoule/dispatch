'use client';

import type { ReactNode } from 'react';

import { cx } from '../tasks/class-names';
import { joinIds, useFieldControl } from './field';
import styles from './text-field.module.css';
import type { TextFieldProps } from './types';

/* A single-line input: field is Gr8r's bordered .input, inline has no box,
   start / end sit inside it. Inside a Field it takes id and description. */
export function TextField({
  variant = 'field',
  size = 'md',
  start,
  end,
  invalid,
  className,
  id,
  'aria-describedby': describedBy,
  'aria-invalid': ariaInvalid,
  ref,
  ...rest
}: TextFieldProps): ReactNode {
  const field = useFieldControl();
  const isInvalid = invalid === true || field?.invalid === true;
  const shared = {
    ...rest,
    ref,
    id: id ?? field?.id,
    'aria-describedby': joinIds(describedBy, field?.describedBy),
    'aria-invalid': isInvalid ? true : ariaInvalid,
  };
  const adorned =
    (start !== undefined && start !== null) ||
    (end !== undefined && end !== null);

  if (variant === 'inline') {
    return (
      <input
        {...shared}
        className={cx(styles.inline, styles[size], className)}
      />
    );
  }
  if (!adorned) {
    return (
      <input
        {...shared}
        className={cx('input', styles.field, styles[size], className)}
      />
    );
  }
  return (
    <span
      className={cx('input', styles.group, styles[size], className)}
      data-invalid={isInvalid ? 'true' : undefined}
      data-disabled={rest.disabled === true ? 'true' : undefined}
    >
      {start !== undefined && start !== null ? (
        <span className={styles.adornment}>{start}</span>
      ) : null}
      <input {...shared} className={styles.bare} />
      {end !== undefined && end !== null ? (
        <span className={styles.adornment}>{end}</span>
      ) : null}
    </span>
  );
}
