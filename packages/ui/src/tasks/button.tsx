'use client';

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
   renders through the host's <Link>, so it can sit in any router. */
export function Button(props: ButtonProps) {
  const {
    variant = 'secondary',
    size = 'md',
    block = false,
    icon,
    iconAfter,
    children,
    className,
  } = props;
  const classes = cx(
    styles.button,
    styles[variant],
    styles[size],
    block ? styles.block : undefined,
    children === undefined || children === null ? styles.iconOnly : undefined,
    className
  );
  const body = (
    <>
      {icon !== undefined ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children !== undefined && children !== null ? (
        <span className={styles.text}>{children}</span>
      ) : null}
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
        href={props.href}
        className={classes}
        aria-label={props['aria-label']}
        title={props.title}
        onClick={props.onClick}
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
      type={props.type ?? 'button'}
      className={classes}
      disabled={props.disabled}
      onClick={props.onClick}
      aria-label={props['aria-label']}
      aria-pressed={props['aria-pressed']}
      aria-expanded={props['aria-expanded']}
      aria-controls={props['aria-controls']}
      title={props.title}
      data-variant={variant}
    >
      {body}
    </button>
  );
}
