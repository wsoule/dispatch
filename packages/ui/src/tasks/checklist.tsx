import { Checkbox } from './checkbox';
import styles from './checklist.module.css';
import { Chip } from './chip';
import { cx } from './class-names';
import type { ChecklistProps } from './types';

/* A checklist panel, Gr8r's, in one of two modes.

   Read only (no `onToggle`): the rubric. A met item has a neutral disc
   with a tick and a quiet "Met" (a settled fact, like a complete
   milestone), a missing one a dashed amber ring and an amber "Missing"
   chip, the only hue in the list (docs/architecture.md §8.2: met =
   default, missing = warning). The result is always said in words too,
   so neither the mark nor its colour is the only carrier of meaning.

   Ticked by a person (with `onToggle`): each row is the library
   Checkbox (a reviewer's acceptance criteria), named by the item's label
   with its note after it. The box is the state, so there is no mark, no
   Met / Missing column and no hue: a person's own ticks are not a
   status. A tick calls `onToggle(id, next)` and the host owns `met`. */
export function Checklist({
  items,
  label,
  metLabel = 'Met',
  missingLabel = 'Missing',
  onToggle,
}: ChecklistProps) {
  if (onToggle !== undefined) {
    return (
      <CheckboxChecklist items={items} label={label} onToggle={onToggle} />
    );
  }
  return (
    <ul className={styles.list} aria-label={label}>
      {items.map((item, i) => (
        <li
          key={item.id ?? `${i}:${item.label}`}
          className={cx(styles.item, item.met ? styles.met : styles.missing)}
          data-met={item.met}
        >
          <span className={styles.mark} aria-hidden="true" />
          <span className={styles.main}>
            <span className={styles.label}>{item.label}</span>
            {item.note !== undefined && item.note !== '' ? (
              <span className={styles.note}>{item.note}</span>
            ) : null}
          </span>
          <span className={styles.state}>
            {item.met ? (
              metLabel
            ) : (
              <Chip tone="warning" filled>
                {missingLabel}
              </Chip>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* The `onToggle` mode's rows: the same list and dividers as the rubric,
   one Checkbox per item, controlled by `met`. An item without an id is
   reported by its index (`String(index)`), for hosts that store ticks by
   position. */
function CheckboxChecklist({
  items,
  label,
  onToggle,
}: Pick<ChecklistProps, 'items' | 'label'> & {
  onToggle: (id: string, met: boolean) => void;
}) {
  return (
    <ul className={styles.list} aria-label={label}>
      {items.map((item, i) => {
        const id = item.id ?? String(i);
        return (
          <li
            key={item.id ?? `${i}:${item.label}`}
            className={styles.tickItem}
            data-met={item.met}
          >
            <Checkbox
              label={item.label}
              note={item.note}
              checked={item.met}
              onChange={(next) => onToggle(id, next)}
            />
          </li>
        );
      })}
    </ul>
  );
}
