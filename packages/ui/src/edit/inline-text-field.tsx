'use client';

import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { cx } from '../tasks/class-names';
import styles from './inline-text-field.module.css';
import { useSaveControl } from './save-state';
import { PendingNote, SaveErrorLine, SavingAnnouncement } from './save-status';
import { editLabels } from './shared';
import type { InlineTextFieldProps } from './types';

const useClientLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** One line of text: pasted line breaks become spaces. */
function singleLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ');
}

/** Grows a textarea to its content (where CSS field-sizing cannot).
    scrollHeight is content + padding, but the box is border-box, so the
    borders are added back: without them the editor came out 2px shorter
    than the text it replaces and everything below moved up on open. */
function fitHeight(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  const borders = el.offsetHeight - el.clientHeight;
  el.style.height = `${el.scrollHeight + borders}px`;
}

/**
 * A single line of text edited in place, for a task's title: it reads as
 * the text (in whatever voice surrounds it, e.g. the view's heading) and
 * is a button, so a click or Enter opens the editor. In the editor Enter
 * saves, Esc cancels, and leaving the field saves a change. The editor
 * wraps long titles over several lines but never takes a line break.
 *
 * Saving follows the family's contract: the new text shows at once with a
 * "Saving" note; a rejection rolls the view back to `value`, reopens the
 * editor with the rejected text so nothing typed is lost, and prints the
 * error under it. An empty value is refused when `required`.
 */
export function InlineTextField({
  label,
  value,
  onSave,
  placeholder,
  required = true,
  maxLength,
  formatError,
  labels: labelOverrides,
  disabled = false,
  className,
}: InlineTextFieldProps): ReactNode {
  const labels = editLabels(labelOverrides);
  const control = useSaveControl(value, onSave, formatError, labels.saveFailed);
  const [editing, setEditingState] = useState(false);
  // Mirrors `editing` synchronously: a blur fired while the editor is being
  // removed (after Enter or Esc) must not save the draft a second time.
  const editingRef = useRef(false);
  const setEditing = (next: boolean): void => {
    editingRef.current = next;
    setEditingState(next);
  };
  const [draft, setDraft] = useState(value);
  const [invalid, setInvalid] = useState<string | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const viewRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Where focus goes when the editor closes: back to the view button after
  // Enter or Esc, nowhere after the field was left with Tab or a click.
  const refocusView = useRef(false);
  const hintId = useId();
  const errorId = useId();

  useClientLayoutEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (el === null) return;
    fitHeight(el);
  }, [editing, draft]);

  useEffect(() => {
    if (editing) {
      const el = inputRef.current;
      if (el !== null && document.activeElement !== el) {
        el.focus({ preventScroll: true });
        el.setSelectionRange(el.value.length, el.value.length);
      }
      return;
    }
    if (refocusView.current) {
      refocusView.current = false;
      viewRef.current?.focus({ preventScroll: true });
    }
  }, [editing]);

  function start(): void {
    if (disabled) return;
    setDraft(control.shown);
    setInvalid(null);
    control.clearError();
    setEditing(true);
  }

  function cancel(refocus: boolean): void {
    refocusView.current = refocus;
    setInvalid(null);
    setEditing(false);
  }

  function commit(refocus: boolean): void {
    const text = draft.trim();
    if (text === control.shown.trim()) {
      cancel(refocus);
      return;
    }
    if (required && text === '') {
      if (refocus) {
        setInvalid(labels.required);
      } else {
        // Leaving an emptied field puts the old text back.
        cancel(false);
      }
      return;
    }
    refocusView.current = refocus;
    setInvalid(null);
    setEditing(false);
    void control.save(text).then((saved) => {
      if (saved) return;
      // Reopen with the rejected text; focus it only when the person is
      // still here (on the view button, or nowhere in particular).
      const active = document.activeElement;
      const here =
        active === null ||
        active === document.body ||
        (rootRef.current?.contains(active) ?? false);
      setDraft(text);
      setEditing(true);
      if (!here) refocusView.current = false;
    });
  }

  const error = invalid ?? control.error;
  const shown = control.shown;

  return (
    <span
      ref={rootRef}
      className={cx(styles.root, className)}
      data-inline-text=""
      data-editing={editing ? 'true' : undefined}
    >
      {editing ? (
        <textarea
          ref={inputRef}
          className={styles.input}
          aria-label={label}
          aria-invalid={error !== null ? 'true' : undefined}
          aria-describedby={error !== null ? errorId : undefined}
          rows={1}
          maxLength={maxLength}
          value={draft}
          placeholder={placeholder}
          spellCheck
          enterKeyHint="done"
          onChange={(event) => {
            setDraft(singleLine(event.target.value));
            if (invalid !== null) setInvalid(null);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              commit(true);
            } else if (event.key === 'Escape') {
              // Handled here, so a drawer around the field stays open.
              event.preventDefault();
              event.stopPropagation();
              cancel(true);
            }
          }}
          onBlur={() => {
            if (editingRef.current) commit(false);
          }}
        />
      ) : (
        <button
          ref={viewRef}
          type="button"
          className={styles.view}
          aria-describedby={hintId}
          disabled={disabled}
          data-pending={control.pending ? 'true' : undefined}
          data-empty={shown === '' ? 'true' : undefined}
          onClick={start}
        >
          <span className={styles.text} dir="auto">
            {shown === '' ? (placeholder ?? label) : shown}
          </span>
          {control.pending ? <PendingNote text={labels.saving} /> : null}
        </button>
      )}
      {/* Hidden, not srOnly: it describes the view button without becoming
          part of a heading the field sits in. */}
      <span id={hintId} hidden>
        {`${labels.edit} ${label}`}
      </span>
      <SavingAnnouncement
        pending={control.pending}
        text={`${labels.saving} ${label}`}
      />
      {error !== null ? (
        <SaveErrorLine
          id={errorId}
          label={invalid !== null ? labels.error : labels.notSaved}
          message={error}
          className={styles.error}
        />
      ) : null}
    </span>
  );
}
