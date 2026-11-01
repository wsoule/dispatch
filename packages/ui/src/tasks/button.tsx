'use client';

import { dataAttributes } from '../lib/data-attributes';
import { Link } from '../lib/link';
import styles from './button.module.css';
import { cx } from './class-names';
import type { ButtonAsLinkProps, ButtonProps } from './types';

/* A type guard rather than `props.href !== undefined`: hosts compile this
   source with their own flags, and without strictNullChecks (Dispatch's
   apps/desktop) a check against undefined does not narrow the union. */
function isLink(props: ButtonProps): props is ButtonAsLinkProps {
  return typeof props.href === 'string';
}

/* Gr8r's button: a sentence-case label in a 6px-radius box. primary is
   the purple fill (one per view), secondary the white bordered default,
   quiet the ghost for toolbars, danger a red fill for a destructive or
   irreversible write. sm / md / lg are 26 / 30 / 36px; block stretches it
   across its container. Hover fills are gated off touch. With href it
   renders through the host's <Link>, so it can sit in any router. busy
   (a save or send in flight) disables it with aria-busy and swaps its
   text for busyLabel; it never shows a spinner. A host's data-* hooks
   land on the root element. */
export function Button(props: ButtonProps) {
  const {
    variant = 'secondary',
    size = 'md',
    block = false,
    icon,
    iconAfter,
    className,
  } = props;
  const busy = !isLink(props) && props.busy === true;
  const hasText = props.children !== undefined && props.children !== null;
  const children =
    busy && hasText ? (props.busyLabel ?? 'Saving…') : props.children;
  const hostData = dataAttributes(props);
  const classes = cx(
    styles.button,
    styles[variant],
    styles[size],
    block ? styles.block : undefined,
    hasText ? undefined : styles.iconOnly,
    className
  );
  const body = (
    <>
      {icon !== undefined ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {hasText ? <span className={styles.text}>{children}</span> : null}
      {iconAfter !== undefined ? (
        <span className={styles.icon} aria-hidden="true">
          {iconAfter}
        </span>
      ) : null}
    </>
  );

  if (isLink(props)) {
    const external = props.external === true;
    return (
      <Link
        {...hostData}
        href={props.href}
        className={classes}
        aria-label={props['aria-label']}
        aria-describedby={props['aria-describedby']}
        title={props.title}
        onClick={props.onClick}
        onKeyDown={props.onKeyDown}
        target={external ? '_blank' : undefined}
        rel={external ? 'noreferrer noopener' : undefined}
      >
        {body}
        {external ? (
          <span className="srOnly"> (opens in a new tab)</span>
        ) : null}
      </Link>
    );
  }

  return (
    <button
      {...hostData}
      ref={props.ref}
      id={props.id}
      type={props.type ?? 'button'}
      className={classes}
      disabled={props.disabled === true || busy}
      tabIndex={props.tabIndex}
      form={props.form}
      name={props.name}
      // A host's choice (a dialog's one field-less action); off by default.
      // oxlint-disable-next-line jsx-a11y/no-autofocus
      autoFocus={props.autoFocus}
      onClick={props.onClick}
      onKeyDown={props.onKeyDown}
      onPointerDown={props.onPointerDown}
      onMouseDown={props.onMouseDown}
      onPointerEnter={props.onPointerEnter}
      onPointerLeave={props.onPointerLeave}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
      aria-label={props['aria-label']}
      aria-describedby={props['aria-describedby']}
      aria-pressed={props['aria-pressed']}
      aria-expanded={props['aria-expanded']}
      aria-controls={props['aria-controls']}
      aria-haspopup={props['aria-haspopup']}
      aria-busy={busy ? 'true' : undefined}
      title={props.title}
      data-variant={variant}
    >
      {body}
    </button>
  );
}
