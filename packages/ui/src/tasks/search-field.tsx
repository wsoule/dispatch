'use client';

import { Search, X } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useRef } from 'react';

import { dataAttributes } from '../lib/data-attributes';
import { useMergedRef } from '../lib/refs';
import { Button } from './button';
import { cx } from './class-names';
import styles from './search-field.module.css';
import type { SearchFieldProps } from './types';

/* Gr8r's search box: a native type="search" input named by `label`, a
   leading magnifier, and, while it holds text, a quiet "Clear search"
   button that empties it and puts focus back in the field. Escape clears
   too, and is stopped only when there was something to clear: in an
   empty field it reaches the page, so the next Escape closes what the
   field sits in (Settings, a find bar). onCommit marks the search final
   (Enter, leaving the field, a clear), so a host can update a URL with
   replace while typing and push once at the end. The host's data-* hooks
   land on the wrapper. ViewToolbar draws its search with this (sm, no
   clear button, Escape left to the browser). */
export function SearchField(props: SearchFieldProps): ReactNode {
  const {
    value,
    onChange,
    label,
    placeholder,
    clearLabel = 'Clear search',
    escapeClears = true,
    inputRef,
    size = 'md',
    onCommit,
    clearable = true,
  } = props;
  const own = useRef<HTMLInputElement>(null);
  const ref = useMergedRef(own, inputRef);
  const showClear = clearable && value !== '';

  // Empties the field, says the empty search is final, and keeps focus in
  // the field (the clear button unmounts once the value is '').
  function clear() {
    onChange('');
    onCommit?.('');
    own.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      if (onCommit === undefined) return;
      event.preventDefault();
      onCommit(event.currentTarget.value);
      return;
    }
    if (event.key === 'Escape' && escapeClears && value !== '') {
      event.preventDefault();
      event.stopPropagation();
      clear();
    }
  }

  return (
    <div
      {...dataAttributes(props)}
      className={cx(
        styles.field,
        styles[size],
        clearable ? styles.clearable : undefined
      )}
    >
      <Search
        className={styles.icon}
        size={size === 'sm' ? 13 : 14}
        strokeWidth={1.8}
        aria-hidden="true"
      />
      <input
        ref={ref}
        type="search"
        className={styles.input}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={(event) => onCommit?.(event.currentTarget.value)}
      />
      {showClear ? (
        <span className={styles.clear}>
          <Button
            variant="quiet"
            size="sm"
            aria-label={clearLabel}
            icon={<X size={13} strokeWidth={1.8} />}
            // A press keeps focus in the field (no blur, so no commit of
            // the text being cleared); the click then clears it.
            onMouseDown={(event) => event.preventDefault()}
            onClick={clear}
          />
        </span>
      ) : null}
    </div>
  );
}
