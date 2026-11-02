'use client';

import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';

import { dataAttributes } from '../lib/data-attributes';
import { cx } from './class-names';
import styles from './panel.module.css';
import { activatesRow, fromNestedControl } from './row-activation';
import type { PanelProps, PanelRowProps } from './types';

/** Whether a slot was given something to draw (0 counts; null, undefined,
    false and '' do not). */
function shown(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== '';
}

/* Gr8r's embedded panel: a --surface box in a 1px --border at --r-lg,
   with a 40px heading row (the heading, a quiet tabular count after it,
   the host's actions at the end) over its body, padded unless `flush`.
   A tone adds data-tone and a 2px edge in its hue at the left, nothing
   else; `floating` adds --shadow-pop for the one panel that floats (the
   first-task guide). The host's data-* hooks land on the root. */
export function Panel(props: PanelProps) {
  const {
    heading,
    count,
    actions,
    tone,
    floating = false,
    flush = false,
    as: Root = 'section',
    headingLevel: Heading = 'h3',
    className,
    children,
  } = props;
  const toned = tone !== undefined && tone !== 'default' ? tone : undefined;
  const hasActions = shown(actions);
  const hasHeader = shown(heading) || count !== undefined || hasActions;
  return (
    <Root
      {...dataAttributes(props)}
      className={cx(styles.panel, className)}
      data-tone={toned}
      data-floating={floating ? 'true' : undefined}
    >
      {hasHeader ? (
        <div className={styles.header} data-part="header">
          {shown(heading) ? (
            <Heading className={styles.heading}>{heading}</Heading>
          ) : null}
          {count !== undefined ? (
            <span className={styles.count} data-part="count">
              {count}
            </span>
          ) : null}
          {hasActions ? (
            <div className={styles.actions} data-part="actions">
              {actions}
            </div>
          ) : null}
        </div>
      ) : null}
      <div
        className={cx(styles.body, flush ? styles.flush : undefined)}
        data-part="body"
        data-flush={flush ? 'true' : undefined}
      >
        {children}
      </div>
    </Root>
  );
}

/* A row of a Panel, ruled off from the next by --divider. With
   `onActivate` the row is a div with role="button" and a tab stop, not a
   <button>, so the buttons it holds stay valid HTML; a click on the row
   (not on a control inside it) and Enter or Space typed on the row itself
   activate it. `urgent` draws a 2px warning edge (data-tone="warning")
   and leads with `urgentLabel` in the tone's ink, or an sr-only "Urgent",
   so the edge is never the only signal. The rest of the props, the ref
   and the host's data-* hooks go to the div. */
export function PanelRow(props: PanelRowProps) {
  const {
    children,
    urgent = false,
    urgentLabel,
    onActivate,
    onClick,
    onKeyDown,
    className,
    ref,
    ...rest
  } = props;
  const activatable = onActivate !== undefined;
  return (
    <div
      {...rest}
      ref={ref}
      className={cx(
        styles.row,
        activatable ? styles.activatable : undefined,
        className
      )}
      data-tone={urgent ? 'warning' : rest['data-tone']}
      data-urgent={urgent ? 'true' : undefined}
      role={rest.role ?? (activatable ? 'button' : undefined)}
      tabIndex={rest.tabIndex ?? (activatable ? 0 : undefined)}
      onClick={
        onActivate === undefined
          ? onClick
          : (event: MouseEvent<HTMLDivElement>) => {
              onClick?.(event);
              if (event.defaultPrevented || fromNestedControl(event)) return;
              onActivate();
            }
      }
      onKeyDown={
        onActivate === undefined
          ? onKeyDown
          : (event: KeyboardEvent<HTMLDivElement>) => {
              onKeyDown?.(event);
              if (!activatesRow(event)) return;
              event.preventDefault();
              onActivate();
            }
      }
    >
      {urgent ? (
        urgentLabel !== undefined && urgentLabel !== '' ? (
          <span className={styles.urgentLabel} data-part="urgent">
            {urgentLabel}
          </span>
        ) : (
          <span className="srOnly" data-part="urgent">
            {'Urgent, '}
          </span>
        )
      ) : null}
      {children}
    </div>
  );
}
