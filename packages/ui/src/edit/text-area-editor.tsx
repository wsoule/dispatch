'use client';

import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from 'react';

import { useModKeyLabel } from '../shell/dom';
import { KbdKeys } from '../shell/kbd';
import { Button } from '../tasks/button';
import { cx } from '../tasks/class-names';
import { useSaveControl } from './save-state';
import { PendingNote, SaveErrorLine, SavingAnnouncement } from './save-status';
import { editLabels } from './shared';
import styles from './text-area-editor.module.css';
import type { TextAreaEditorProps } from './types';

const useClientLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

type Refocus = 'edit' | 'input' | null;

/**
 * Plain-text (markdown source) editing for a description or a new comment.
 * Nothing is parsed: the text is stored as typed, and the default view
 * prints it with its line breaks (a host renders markdown through `view`).
 *
 * edit mode: the text with an Edit button; Edit swaps in the editor with
 * Save and Cancel. compose mode: the editor is always open (a comment box)
 * and a save clears it. In the editor ⌘/Ctrl+Enter saves. Esc cancels an
 * unchanged edit; with changes the first Esc only warns and the second
 * discards, so a drawer around the editor never closes on a draft. A
 * character count appears near `maxLength`, in red past it.
 *
 * Saving follows the family's contract: Save shows "Saving" and locks the
 * text; on rejection the draft stays in the editor with the error under it.
 */
export function TextAreaEditor({
  label,
  value = '',
  onSave,
  mode = 'edit',
  view,
  emptyLabel,
  placeholder,
  maxLength,
  countFrom,
  rows,
  editing: editingProp,
  onEditingChange,
  saveLabel,
  editLabel,
  formatError,
  labels: labelOverrides,
  disabled = false,
  className,
}: TextAreaEditorProps): ReactNode {
  const labels = editLabels(labelOverrides);
  const compose = mode === 'compose';
  const modKey = useModKeyLabel();
  const control = useSaveControl(
    compose ? '' : value,
    onSave,
    formatError,
    labels.saveFailed,
    !compose
  );
  const [editingState, setEditingState] = useState(false);
  const editing = compose || (editingProp ?? editingState);
  const [draft, setDraft] = useState(compose ? '' : value);
  const [escArmed, setEscArmed] = useState(false);
  // Forces a render, so the refocus effect runs once a save settles.
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const refocus = useRef<Refocus>(null);
  const wasEditing = useRef(editing);
  const hintId = useId();
  const countId = useId();
  const errorId = useId();

  function setEditing(next: boolean): void {
    if (editingProp === undefined) setEditingState(next);
    onEditingChange?.(next);
  }

  // Opening the editor (here or from the host's own Edit button) starts
  // from the shown text, with the caret at its end.
  useClientLayoutEffect(() => {
    const opened = editing && !wasEditing.current;
    wasEditing.current = editing;
    if (!opened || compose) return;
    setDraft(control.shown);
    setEscArmed(false);
    const el = inputRef.current;
    if (el !== null) {
      el.focus({ preventScroll: true });
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing]);

  useEffect(() => {
    const target = refocus.current;
    refocus.current = null;
    if (target === 'edit')
      editButtonRef.current?.focus({ preventScroll: true });
    if (target === 'input') inputRef.current?.focus({ preventScroll: true });
  });

  const dirty = compose ? draft !== '' : draft !== control.shown;
  const limit = maxLength;
  const countStart =
    countFrom ?? (limit === undefined ? Infinity : Math.floor(limit * 0.8));
  const showCount = limit !== undefined && draft.length >= countStart;
  const over = limit !== undefined && draft.length > limit;

  function cancel(): void {
    setEscArmed(false);
    if (compose) {
      setDraft('');
      refocus.current = 'input';
      return;
    }
    refocus.current = 'edit';
    setEditing(false);
  }

  function save(): void {
    if (control.pending || disabled || over) return;
    const next = draft;
    setEscArmed(false);
    if (compose) {
      if (next.trim() === '') return;
    } else if (next === control.shown) {
      refocus.current = 'edit';
      setEditing(false);
      return;
    }
    control.clearError();
    void control.save(next).then((saved) => {
      // Focus returns where the person will continue, unless they have
      // moved elsewhere on the page meanwhile.
      const active = document.activeElement;
      const here =
        active === null ||
        active === document.body ||
        (rootRef.current?.contains(active) ?? false);
      if (saved && compose) {
        setDraft('');
        if (here) refocus.current = 'input';
      } else if (saved) {
        if (here) refocus.current = 'edit';
        setEditing(false);
      } else if (here) {
        refocus.current = 'input';
      }
      rerender();
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      save();
      return;
    }
    if (event.key !== 'Escape') return;
    if (!dirty) {
      // An empty comment box lets Esc through (it closes a drawer); an
      // unchanged edit closes the editor first.
      if (compose) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (escArmed) cancel();
    else setEscArmed(true);
  }

  const shownText = control.shown;
  const describedBy = [
    hintId,
    showCount ? countId : null,
    control.error !== null ? errorId : null,
  ]
    .filter((part) => part !== null)
    .join(' ');

  if (!editing) {
    let body: ReactNode;
    if (typeof view === 'function') body = view(shownText);
    else if (view !== undefined && view !== null) body = view;
    else if (shownText.trim() === '') {
      body = <p className={styles.empty}>{emptyLabel ?? placeholder ?? ''}</p>;
    } else {
      body = (
        <div className={styles.text} dir="auto">
          {shownText}
        </div>
      );
    }
    return (
      <div
        ref={rootRef}
        className={cx(styles.root, className)}
        data-text-editor="view"
      >
        <div
          className={styles.view}
          data-pending={control.pending ? 'true' : undefined}
        >
          {body}
        </div>
        <div className={styles.foot}>
          {control.pending ? <PendingNote text={labels.saving} /> : null}
          <button
            ref={editButtonRef}
            type="button"
            className={styles.edit}
            aria-label={`${editLabel ?? labels.edit} ${label}`}
            disabled={disabled}
            onClick={() => setEditing(true)}
          >
            {editLabel ?? labels.edit}
          </button>
        </div>
        <SavingAnnouncement
          pending={control.pending}
          text={`${labels.saving} ${label}`}
        />
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={cx(styles.root, className)}
      data-text-editor={compose ? 'compose' : 'edit'}
      data-invalid={over || control.error !== null ? 'true' : undefined}
    >
      <textarea
        ref={inputRef}
        className={styles.input}
        aria-label={label}
        aria-describedby={describedBy}
        aria-invalid={over || control.error !== null ? 'true' : undefined}
        rows={rows ?? (compose ? 3 : 6)}
        placeholder={placeholder}
        maxLength={maxLength}
        value={draft}
        readOnly={control.pending}
        disabled={disabled}
        data-pending={control.pending ? 'true' : undefined}
        onChange={(event) => {
          setDraft(event.target.value);
          setEscArmed(false);
        }}
        onKeyDown={onKeyDown}
      />
      <div className={styles.bar}>
        <span className={styles.hint} id={hintId}>
          <KbdKeys keys={[modKey, '↵']} /> {labels.saveShortcut}
        </span>
        {escArmed ? (
          <span className={styles.armed} role="status">
            {labels.unsaved}
          </span>
        ) : null}
        {showCount && limit !== undefined ? (
          <span
            id={countId}
            className={styles.count}
            data-over={over ? 'true' : undefined}
          >
            {draft.length} / {limit}
          </span>
        ) : null}
        <span className={styles.actions}>
          {control.pending ? <PendingNote text={labels.saving} /> : null}
          {!compose || draft !== '' ? (
            <Button
              variant="quiet"
              size="sm"
              disabled={control.pending}
              onClick={cancel}
            >
              {labels.cancel}
            </Button>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            disabled={
              control.pending ||
              disabled ||
              over ||
              (compose && draft.trim() === '')
            }
            onClick={save}
          >
            {saveLabel ?? (compose ? 'Comment' : labels.save)}
          </Button>
        </span>
      </div>
      {control.error !== null ? (
        <SaveErrorLine
          id={errorId}
          label={labels.notSaved}
          message={control.error}
        />
      ) : null}
      <SavingAnnouncement
        pending={control.pending}
        text={`${labels.saving} ${label}`}
      />
    </div>
  );
}
