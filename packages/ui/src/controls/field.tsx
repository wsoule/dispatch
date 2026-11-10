'use client';

import { createContext, type ReactNode, useContext, useId } from 'react';

import { cx } from '../tasks/class-names';
import styles from './field.module.css';
import type { FieldProps } from './types';

/** What a Field tells the control inside it. */
interface FieldControl {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
}

const FieldContext = createContext<FieldControl | null>(null);

/** The surrounding Field's id, description and error state, if any. */
export function useFieldControl(): FieldControl | null {
  return useContext(FieldContext);
}

/** Joins id lists for aria-describedby, dropping empty ones. */
export function joinIds(
  ...ids: (string | null | undefined)[]
): string | undefined {
  const out = ids.filter((id) => typeof id === 'string' && id !== '');
  return out.length > 0 ? out.join(' ') : undefined;
}

/* A labelled form row with a hint and an error under the control, which
   takes its id, aria-describedby and aria-invalid from context. */
export function Field({
  label,
  hint,
  error,
  id,
  children,
  className,
}: FieldProps): ReactNode {
  const baseId = useId();
  const controlId = id ?? `${baseId}-control`;
  const hasHint = hint !== undefined && hint !== null && hint !== false;
  const hasError = error !== undefined && error !== null && error !== false;
  const hintId = hasHint ? `${baseId}-hint` : undefined;
  const errorId = hasError ? `${baseId}-error` : undefined;
  const control: FieldControl = {
    id: controlId,
    describedBy: joinIds(errorId, hintId),
    invalid: hasError,
  };
  return (
    <div className={cx(styles.field, className)}>
      <label className={styles.label} htmlFor={controlId}>
        {label}
      </label>
      <FieldContext.Provider value={control}>{children}</FieldContext.Provider>
      {hasHint ? (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      ) : null}
      {hasError ? (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
