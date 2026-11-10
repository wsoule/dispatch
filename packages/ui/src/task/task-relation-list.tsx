import type { MouseEvent, ReactNode } from 'react';

import { Link } from '../lib/link';
import { Chip } from '../tasks/chip';
import { cx } from '../tasks/class-names';
import { StateGlyph } from '../tasks/task-glyphs';
import { RelationRemoveButton } from './relation-remove-button';
import { DEFAULT_TASK_LABELS, isExternalHref } from './shared';
import styles from './task-relation-list.module.css';
import type { TaskRelation, TaskRelationListProps } from './types';

/** True for a plain left click: modified clicks (new tab, new window,
    download) are left to the browser so the link still works as a link. */
function isPlainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/** The separator between facts: a drawn middot, read as a comma (a
    hidden dot alone would run the facts together: "In ProgressDev
    Patel"). */
function Dot(): ReactNode {
  return (
    <>
      {/* No-break space before the dot: a wrapped line never starts with
          one. */}
      <span className={styles.dot} aria-hidden="true">
        {'\u00a0· '}
      </span>
      <span className="srOnly">, </span>
    </>
  );
}

/* What a row prints: glyph, key and title on the first line; state,
   assignee, context and tags in the meta voice under the title (an open
   task with nobody on it says "Unassigned" in the warning tone). */
function RowBody({
  relation,
  externalLabel,
  resolvedLabel,
  unassignedLabel,
  newTabNote,
}: {
  relation: TaskRelation;
  externalLabel: string;
  resolvedLabel: string;
  unassignedLabel: string;
  newTabNote: string | null;
}): ReactNode {
  const { taskKey, title, state, assignee, context, external, resolved } =
    relation;
  return (
    <>
      <span className={styles.glyph}>
        <StateGlyph kind={state.kind} size={14} />
      </span>
      <span className={styles.key}>{taskKey}</span>
      <span className={styles.title} dir="auto">
        {title}
        {newTabNote !== null ? (
          <span className="srOnly"> ({newTabNote})</span>
        ) : null}
      </span>
      <span className={styles.meta}>
        <span className={styles.facts}>
          <span className={styles.state}>{state.label}</span>
          {assignee !== undefined ? (
            <>
              <Dot />
              <span
                className={
                  assignee === null && resolved !== true
                    ? styles.unassigned
                    : undefined
                }
              >
                {assignee ?? unassignedLabel}
              </span>
            </>
          ) : null}
          {context !== undefined && context !== '' ? (
            <>
              <Dot />
              <span>{context}</span>
            </>
          ) : null}
        </span>
        {external === true ? (
          <>
            <span className="srOnly">, </span>
            <Chip tone="muted">{externalLabel}</Chip>
          </>
        ) : null}
        {resolved === true ? (
          <>
            <span className="srOnly">, </span>
            <Chip tone="muted">{resolvedLabel}</Chip>
          </>
        ) : null}
      </span>
    </>
  );
}

/**
 * A register of related tasks (what this one is blocked by, or blocks).
 * Each row is a link through the host's <Link> when it has an href (http
 * URLs open in a new tab), a button when it only has onOpen, or plain text
 * when it has neither. With both, a plain click opens in place and a
 * modified click follows the link. Resolved blockers are struck through
 * and muted; tasks outside the viewer's scope carry a tag. A row with
 * onRemove gets a remove button beside it (a sibling, so no control nests
 * in another); a promise it returns marks the row busy, and a rejection
 * prints under the row. The key column is as wide as the longest key.
 * Not a client module: without callbacks it renders in a server component.
 */
export function TaskRelationList({
  items,
  label,
  emptyLabel = 'None',
  onOpen,
  externalLabel = DEFAULT_TASK_LABELS.external,
  resolvedLabel = DEFAULT_TASK_LABELS.resolved,
  unassignedLabel = DEFAULT_TASK_LABELS.unassigned,
  newTabLabel = DEFAULT_TASK_LABELS.opensInNewTab,
  removeLabel = DEFAULT_TASK_LABELS.remove,
  notSavedLabel = DEFAULT_TASK_LABELS.notSaved,
}: TaskRelationListProps): ReactNode {
  if (items.length === 0) {
    return <p className={styles.empty}>{emptyLabel}</p>;
  }
  const removable = items.some((item) => item.onRemove !== undefined);
  return (
    <ul
      className={cx(styles.list, removable ? styles.removable : undefined)}
      aria-label={label}
      data-removable={removable ? 'true' : undefined}
    >
      {items.map((relation) => {
        const open =
          relation.onOpen ??
          (onOpen !== undefined ? () => onOpen(relation) : undefined);
        const className = cx(
          styles.row,
          relation.href !== undefined || open !== undefined
            ? styles.interactive
            : undefined
        );
        const external =
          relation.href !== undefined && isExternalHref(relation.href);
        const body = (
          <RowBody
            relation={relation}
            externalLabel={externalLabel}
            resolvedLabel={resolvedLabel}
            unassignedLabel={unassignedLabel}
            newTabNote={external && open === undefined ? newTabLabel : null}
          />
        );
        let row: ReactNode;
        if (relation.href !== undefined) {
          row = (
            <Link
              href={relation.href}
              className={className}
              target={external ? '_blank' : undefined}
              rel={external ? 'noreferrer' : undefined}
              onClick={
                open === undefined
                  ? undefined
                  : (event) => {
                      if (event.defaultPrevented || !isPlainClick(event)) {
                        return;
                      }
                      event.preventDefault();
                      open();
                    }
              }
            >
              {body}
            </Link>
          );
        } else if (open !== undefined) {
          row = (
            <button type="button" className={className} onClick={open}>
              {body}
            </button>
          );
        } else {
          row = <div className={className}>{body}</div>;
        }
        return (
          <li
            key={relation.id}
            className={cx(
              styles.item,
              relation.resolved === true ? styles.resolved : undefined
            )}
            data-resolved={relation.resolved === true ? 'true' : undefined}
            data-external={relation.external === true ? 'true' : undefined}
          >
            {row}
            {relation.onRemove !== undefined ? (
              <RelationRemoveButton
                taskKey={relation.taskKey}
                removeLabel={removeLabel}
                notSavedLabel={notSavedLabel}
                onRemove={relation.onRemove}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
