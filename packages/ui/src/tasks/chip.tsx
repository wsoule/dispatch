import type { ReactNode } from 'react';

import StatusMark from '../components/status-mark';
import { dataAttributes } from '../lib/data-attributes';
import { Link } from '../lib/link';
import type { UiStatus } from '../types';
import styles from './chip.module.css';
import { cx } from './class-names';
import type { ChipButtonProps, ChipProps, ChipTone } from './types';

/* The tones that carry a status (docs/architecture.md §8.2). */
const SEMANTIC: ReadonlySet<ChipTone> = new Set<ChipTone>([
  'danger',
  'warning',
  'success',
  'info',
]);

/* Gr8r's badge: a short sentence-case label in a 5px-radius chip. Tone is
   the variable (data-tone gives the CSS --tone, --tone-ink, --tone-soft):
   default is the neutral badge, muted plain quiet text (no box), accent
   the accent's text on its soft tint (new, unread), inverse the dark slab.
   A status tone (danger, warning, success, info) is drawn one of two ways:
   `filled` (the stronger claim: blocked, failed, live, assigned, sent) is
   Gr8r's tinted badge, the tone's text on its soft tint; without it the
   chip is Gr8r's status pill, neutral and bordered with the hue in a 6px
   dot (running, succeeded, at risk, a Linear project status). Muted with
   `dot` is that pill with a grey dot (an inactive project's Linear
   status). A leading status mark replaces the dot (its shape and hue say
   the status), so the colour is never the only cue: the words always say
   it too. The host's data-* hooks land on the chip. */
export function Chip(props: ChipProps) {
  const { tone = 'default', filled = false, dot = false, title } = props;
  const look = chipLook(tone, filled, dot);
  return (
    <span
      {...dataAttributes(props)}
      className={cx(styles.chip, look.className)}
      data-tone={tone}
      data-filled={look.filled ? '' : undefined}
      title={title}
    >
      <ChipBody
        pill={look.pill}
        status={props.status}
        statusLabel={props.statusLabel}
      >
        {props.children}
      </ChipBody>
    </span>
  );
}

/* Which of the chip's drawings a tone takes (see Chip): the status pill
   (a status tone without `filled`, or muted with `dot`), the tinted badge
   (a filled status tone), or the tone's own class (default, muted,
   accent, inverse). Shared by Chip and ChipButton so both look alike. */
function chipLook(
  tone: ChipTone,
  filled: boolean,
  dot: boolean
): { className: string | undefined; pill: boolean; filled: boolean } {
  const semantic = SEMANTIC.has(tone);
  const pill = (semantic && !filled) || (tone === 'muted' && dot);
  return {
    className: pill ? styles.pill : semantic ? styles.tinted : styles[tone],
    pill,
    filled: semantic && filled,
  };
}

/* The inside of a chip: the pill's 6px dot (unless a status mark takes
   its place), the optional status mark, then the words. */
function ChipBody({
  pill,
  status,
  statusLabel,
  children,
}: {
  pill: boolean;
  status: UiStatus | undefined;
  statusLabel: string | undefined;
  children: ReactNode;
}) {
  return (
    <>
      {pill && status === undefined ? (
        <span className={styles.dot} aria-hidden="true" />
      ) : null}
      {status !== undefined ? (
        <span className={styles.mark}>
          <StatusMark status={status} label={statusLabel ?? status} />
        </span>
      ) : null}
      <span className={styles.text}>{children}</span>
    </>
  );
}

/* A chip that does something, in the chip's look: a
   <button type="button">, or the host's <Link> with `href` (a door, a
   reference to open). It takes a hover fill and the focus ring; its name
   is its visible text (and a status mark's label). `selected` makes a
   button a toggle (aria-pressed), drawn in the accent's selection tint;
   `disabled` disables the button, or turns a link into its text
   marked aria-disabled. The host's data-* hooks land on the button or
   the link. */
export function ChipButton(props: ChipButtonProps) {
  const {
    tone = 'default',
    filled = false,
    dot = false,
    title,
    onClick,
    href,
    selected,
    disabled = false,
  } = props;
  const look = chipLook(tone, filled, dot);
  const className = cx(styles.chip, look.className, styles.button);
  const shared = {
    ...dataAttributes(props),
    'data-tone': tone,
    'data-filled': look.filled ? '' : undefined,
    'data-chip-button': '',
    title,
  };
  const body = (
    <ChipBody
      pill={look.pill}
      status={props.status}
      statusLabel={props.statusLabel}
    >
      {props.children}
    </ChipBody>
  );
  if (typeof href === 'string') {
    if (disabled) {
      return (
        <span {...shared} className={className} aria-disabled="true">
          {body}
        </span>
      );
    }
    return (
      <Link {...shared} href={href} className={className} onClick={onClick}>
        {body}
      </Link>
    );
  }
  return (
    <button
      {...shared}
      type="button"
      className={className}
      disabled={disabled}
      aria-pressed={selected}
      onClick={onClick}
    >
      {body}
    </button>
  );
}
