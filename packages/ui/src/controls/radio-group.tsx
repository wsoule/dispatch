'use client';

import { type KeyboardEvent, type ReactNode, useId, useRef } from 'react';

import { dataAttributes } from '../lib/data-attributes';
import { cx } from '../tasks/class-names';
import styles from './radio-group.module.css';
import type { RadioGroupProps, RadioOption } from './types';

/* The keys a browser moves (and checks) a native radio with. */
const ARROW_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

/* Whether an optional slot (a hint, a badge, an aside, children) has
   anything to draw, so an empty one adds no wrapper or description. */
function hasContent(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false;
}

/* Exclusive choices as native radios (visually hidden), so the browser's
   arrow keys move and pick; an option's hint describes it. `plain` sets
   each option as a ring and its words; `cards` boxes each one in a row
   that is a target as a whole, the checked one on the hover fill with an
   accent edge. An option's `badge` sits inside its label (part of the
   radio's name), its `aside` beside the label (buttons that stay out of
   the name), and its `children` under it only while it is checked. With
   `activation="manual"` an arrow key only moves focus: the change it
   makes is not reported, so Space, Enter or a click picks (a choice that
   acts at once, like approving a tool call), and each of them on the
   checked radio reports it again, as pressing a button would. A host's
   data-* hooks land on the radiogroup. */
export function RadioGroup(props: RadioGroupProps): ReactNode {
  const {
    options,
    value,
    onChange,
    label,
    'aria-labelledby': labelledBy,
    orientation = 'vertical',
    variant = 'plain',
    activation = 'auto',
    disabled = false,
  } = props;
  const idBase = useId();
  const name = props.name ?? idBase;
  const manual = activation === 'manual';
  // Manual activation: set by an arrow keydown on one of the radios and
  // cleared by the next other key, keyup or pointer press, so the change
  // the browser fires while the arrow moves focus is the one dropped.
  const arrowed = useRef(false);

  function onGroupKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target;
    arrowed.current =
      ARROW_KEYS.has(event.key) &&
      target instanceof HTMLInputElement &&
      target.type === 'radio';
  }

  function clearArrowed() {
    arrowed.current = false;
  }

  function pick(option: RadioOption) {
    if (manual && arrowed.current) return;
    onChange(option.value);
  }

  // Manual activation: a click (or Space, which clicks) on the radio that
  // is already checked fires no change, yet is an answer given again (a
  // denial whose reason box was sent and closed, opened once more). An
  // unchecked radio's click is left to its change, so nothing is
  // reported twice; an arrow's click is dropped like its change.
  function onRadioClick(option: RadioOption, checked: boolean, off: boolean) {
    if (!checked || off || arrowed.current) return;
    onChange(option.value);
  }

  // Manual activation: Enter on a focused radio picks it (the legacy
  // option buttons did), and keeps it from submitting a surrounding form.
  function onRadioKeyDown(
    event: KeyboardEvent<HTMLInputElement>,
    option: RadioOption,
    off: boolean
  ) {
    if (event.key !== 'Enter' || off) return;
    event.preventDefault();
    onChange(option.value);
  }

  return (
    <div
      {...dataAttributes(props)}
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-orientation={orientation}
      aria-disabled={disabled ? true : undefined}
      className={cx(
        styles.group,
        variant === 'cards' ? styles.cards : undefined
      )}
      data-orientation={orientation}
      data-variant={variant}
      onKeyDown={manual ? onGroupKeyDown : undefined}
      onKeyUp={manual ? clearArrowed : undefined}
      onPointerDown={manual ? clearArrowed : undefined}
    >
      {options.map((option, index) => {
        const hintId = `${idBase}-hint-${String(index)}`;
        const hasHint = hasContent(option.hint);
        const off = disabled || option.disabled === true;
        const checked = value === option.value;
        return (
          <div
            key={option.value}
            className={styles.option}
            data-checked={checked ? 'true' : undefined}
            data-disabled={off ? 'true' : undefined}
          >
            <div className={styles.head}>
              <div className={styles.main}>
                <label className={styles.row}>
                  <input
                    type="radio"
                    className={styles.input}
                    name={name}
                    value={option.value}
                    checked={checked}
                    disabled={off}
                    aria-label={option['aria-label']}
                    aria-describedby={hasHint ? hintId : undefined}
                    onChange={() => pick(option)}
                    onClick={
                      manual
                        ? () => onRadioClick(option, checked, off)
                        : undefined
                    }
                    onKeyDown={
                      manual
                        ? (event) => onRadioKeyDown(event, option, off)
                        : undefined
                    }
                  />
                  <span className={styles.ring} aria-hidden="true" />
                  <span className={styles.label}>
                    {option.label}
                    {hasContent(option.badge) ? (
                      <>
                        {' '}
                        <span className={styles.badge}>{option.badge}</span>
                      </>
                    ) : null}
                  </span>
                </label>
                {hasHint ? (
                  <span id={hintId} className={styles.hint}>
                    {option.hint}
                  </span>
                ) : null}
              </div>
              {hasContent(option.aside) ? (
                <div className={styles.aside}>{option.aside}</div>
              ) : null}
            </div>
            {checked && hasContent(option.children) ? (
              <div className={styles.body}>{option.children}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
