'use client';

import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';

import { cx } from '../tasks/class-names';
import { joinIds, useFieldControl } from './field';
import styles from './text-area.module.css';
import type { TextAreaProps } from './types';

const useClientLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Grows a textarea to its content; `rows` stays the floor because the
    auto height is measured first. Borders are added back (border-box). */
function fitHeight(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  const borders = el.offsetHeight - el.clientHeight;
  el.style.height = `${el.scrollHeight + borders}px`;
}

/** Hands one element to both the local ref and the host's. */
function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref !== undefined && ref !== null) {
    (ref as { current: T | null }).current = value;
  }
}

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
  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      local.current = el;
      assignRef(ref, el);
    },
    [ref]
  );

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
