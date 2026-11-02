'use client';

import { type ReactNode, useEffect, useLayoutEffect, useRef } from 'react';

import { fitHeight } from '../lib/fit-height';
import { useMergedRef } from '../lib/refs';
import { cx } from '../tasks/class-names';
import { joinIds, useFieldControl } from './field';
import styles from './text-area.module.css';
import type { TextAreaProps } from './types';

const useClientLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

/* A multi-line input that grows with its content. field is the bordered
   .textarea, inline drops the box; inside a Field it takes id and description. */
export function TextArea({
  variant = 'field',
  autoGrow = true,
  invalid,
  className,
  id,
  value,
  onInput,
  'aria-describedby': describedBy,
  'aria-invalid': ariaInvalid,
  ref,
  ...rest
}: TextAreaProps): ReactNode {
  const field = useFieldControl();
  const local = useRef<HTMLTextAreaElement | null>(null);
  // One element for both the auto-grow measure and the host's ref.
  const setRef = useMergedRef(local, ref);

  // A controlled value can change from outside (a reset, a template).
  useClientLayoutEffect(() => {
    if (autoGrow && local.current !== null) fitHeight(local.current);
  }, [autoGrow, value]);

  return (
    <textarea
      {...rest}
      ref={setRef}
      id={id ?? field?.id}
      value={value}
      aria-describedby={joinIds(describedBy, field?.describedBy)}
      aria-invalid={
        invalid === true || field?.invalid === true ? true : ariaInvalid
      }
      className={cx(
        variant === 'field' ? 'textarea' : styles.inline,
        autoGrow ? styles.grow : undefined,
        className
      )}
      onInput={(event) => {
        if (autoGrow) fitHeight(event.currentTarget);
        onInput?.(event);
      }}
    />
  );
}
