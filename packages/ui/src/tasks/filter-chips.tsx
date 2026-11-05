'use client';

import { ListFilter, X } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useRef } from 'react';

import { Button } from './button';
import styles from './filter-chips.module.css';
import type { FilterChipsProps } from './types';

/* Gr8r's filter chips bar (.chipsbar in view-engine.js): one chip per set
   filter, "Project is Atlas billing migration, Beacon search", joined by a
   quiet "and", each with its own × (named "Remove project filter"); then
   the host's "+ Filter" and, at the far right, Clear all. A chip's face can
   be wrapped in the host's picker (renderEditor), so a click on it reopens
   the values. Nothing is drawn while there are no chips.

   Focus does not fall to <body> when a chip goes: a chip removed while
   its × had focus hands it to the next chip (its face's picker, else its
   ×), else the previous one; Clear all hands it to the add control (the
   filters it clears are about to go, and it disables itself). The last
   chip takes the whole bar with it, so a host whose filters can all go
   places focus itself (the Issues page always keeps its status chip). */
export function FilterChips({
  chips,
  add,
  onClearAll,
  clearDisabled = false,
  clearLabel = 'Clear all',
  label = 'Filters',
}: FilterChipsProps): ReactNode {
  if (chips.length === 0) return null;
  return (
    <div className={styles.bar} role="group" aria-label={label}>
      <ListFilter
        className={styles.lead}
        size={13}
        strokeWidth={1.8}
        aria-hidden="true"
      />
      <ul className={styles.list}>
        {chips.map((chip, index) => {
          const face = (
            <span className={styles.face}>
              {chip.icon !== undefined && chip.icon !== null ? (
                <span className={styles.icon} aria-hidden="true">
                  {chip.icon}
                </span>
              ) : null}
              <span className={styles.field}>{chip.field}</span>
              <span className={styles.is}>is</span>
              <span
                className={styles.summary}
                data-unknown={chip.unknown === true ? 'true' : undefined}
              >
                {chip.summary}
              </span>
            </span>
          );
          return (
            <li key={chip.id} className={styles.item}>
              {index > 0 ? <span className={styles.and}>and</span> : null}
              <span
                className={styles.chip}
                data-unknown={chip.unknown === true ? 'true' : undefined}
                data-editable={
                  chip.renderEditor !== undefined ? 'true' : undefined
                }
              >
                {chip.renderEditor !== undefined ? (
                  <span className={styles.editor}>
                    {chip.renderEditor(face)}
                  </span>
                ) : (
                  face
                )}
                <RemoveButton
                  label={chip.removeLabel}
                  onRemove={chip.onRemove}
                />
              </span>
            </li>
          );
        })}
      </ul>
      {add !== undefined && add !== null ? (
        <span className={styles.add} data-filter-add="">
          {add}
        </span>
      ) : null}
      {onClearAll !== undefined ? (
        <span className={styles.clear}>
          <Button
            variant="quiet"
            size="sm"
            disabled={clearDisabled}
            onClick={(event) => {
              // Before the chips go and this button disables itself.
              const bar = (event.currentTarget as HTMLElement).closest(
                '[role="group"]'
              );
              bar
                ?.querySelector<HTMLElement>('[data-filter-add] button')
                ?.focus({ preventScroll: true });
              onClearAll();
            }}
          >
            {clearLabel}
          </Button>
        </span>
      ) : null}
    </div>
  );
}

/* A chip's ×. When its chip goes while it has focus, the layout cleanup
   (it runs before the DOM removal, so the neighbours are still there)
   hands focus to the next chip's first button (its face's picker, else
   its ×), else the previous chip's. A chip that stays (the default status
   chip keeps its id) keeps its × and focus. */
function RemoveButton({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}): ReactNode {
  const buttonRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const button = buttonRef.current;
    return () => {
      if (button === null || document.activeElement !== button) return;
      const item = button.closest('li');
      const first = (sibling: Element | null | undefined) =>
        sibling?.querySelector<HTMLElement>('button') ?? null;
      const next =
        first(item?.nextElementSibling) ?? first(item?.previousElementSibling);
      next?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <button
      ref={buttonRef}
      type="button"
      className={styles.remove}
      aria-label={label}
      title={label}
      onClick={onRemove}
    >
      <X size={12} strokeWidth={1.8} aria-hidden="true" />
    </button>
  );
}
