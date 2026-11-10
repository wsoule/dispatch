'use client';

import { X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';

import { cx } from '../tasks/class-names';
import styles from './date-field.module.css';
import { useSaveControl } from './save-state';
import { PendingNote, SaveErrorLine, SavingAnnouncement } from './save-status';
import { editLabels } from './shared';
import type { DateFieldProps } from './types';

/** A complete calendar date with a four-digit year: what the native field
    reports once every part is filled, and the only thing worth saving
    (typing "2" into the year makes the field report year 0002). */
export function isCompleteDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) return false;
  return Number(match[1]) >= 1000;
}

/**
 * A due date: the browser's own date input (its calendar, its keyboard
 * handling and its locale's format) plus a Clear icon button. A complete date saves after
 * a short pause, at once on Enter or when the field is left; an
 * incomplete or out-of-range date is never saved and is put back when the
 * field is left. Saving follows the family's contract: pending, then the
 * saved date, or the old one back with the error under the field. With
 * `emptyLabel`, an empty field at rest says it ("No due date") over the
 * browser's hidden mask, and shows the mask again once focused.
 */
export function DateField({
  label,
  value,
  onChange,
  clearable = true,
  min,
  max,
  commitDelay = 600,
  emptyLabel,
  formatError,
  labels: labelOverrides,
  disabled = false,
  id,
  className,
}: DateFieldProps): ReactNode {
  const labels = editLabels(labelOverrides);
  const control = useSaveControl(
    value,
    onChange,
    formatError,
    labels.saveFailed
  );
  const [draft, setDraft] = useState('');
  // True while the field holds typing not yet saved; otherwise it shows
  // the saved (or saving) value, so host updates and rollbacks show too.
  const [dirty, setDirty] = useState(false);
  const draftRef = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shown = control.shown;
  const display = dirty ? draft : (shown ?? '');
  const emptyId = useId();
  const empty = emptyLabel !== undefined && emptyLabel !== '' && display === '';

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );

  function inRange(text: string): boolean {
    return (
      (min === undefined || text >= min) && (max === undefined || text <= max)
    );
  }

  function commit(text: string): void {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setDirty(false);
    if (text === '') {
      if (clearable && shown !== null) void control.save(null);
      return;
    }
    if (!isCompleteDate(text) || !inRange(text) || text === shown) return;
    void control.save(text);
  }

  function onInput(text: string): void {
    draftRef.current = text;
    setDraft(text);
    setDirty(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (isCompleteDate(text) && inRange(text)) {
      timer.current = setTimeout(() => commit(draftRef.current), commitDelay);
    }
  }

  return (
    <span
      className={cx(styles.root, className)}
      data-date-field=""
      data-pending={control.pending ? 'true' : undefined}
      data-empty={empty ? 'true' : undefined}
    >
      <span className={styles.row}>
        <input
          id={id}
          type="date"
          className={styles.input}
          aria-label={label}
          aria-describedby={empty ? emptyId : undefined}
          aria-invalid={control.error !== null ? 'true' : undefined}
          value={display}
          min={min}
          max={max}
          disabled={disabled}
          onChange={(event) => onInput(event.target.value)}
          onBlur={() => {
            if (dirty) commit(draftRef.current);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (dirty) commit(draftRef.current);
            }
          }}
        />
        {empty ? (
          <span id={emptyId} className={styles.empty} aria-hidden="true">
            {emptyLabel}
          </span>
        ) : null}
        {clearable && shown !== null ? (
          <button
            type="button"
            className={styles.clear}
            aria-label={`${labels.clear} ${label}`}
            title={labels.clear}
            disabled={disabled}
            onClick={() => commit('')}
          >
            <X size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        ) : null}
        {control.pending ? <PendingNote text={labels.saving} /> : null}
      </span>
      <SavingAnnouncement
        pending={control.pending}
        text={`${labels.saving} ${label}`}
      />
      {control.error !== null ? (
        <SaveErrorLine label={labels.notSaved} message={control.error} />
      ) : null}
    </span>
  );
}
