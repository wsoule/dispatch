import StatusMark from '../components/status-mark';
import styles from './chip.module.css';
import { cx } from './class-names';
import type { ChipProps, ChipTone } from './types';

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
   it too. */
export function Chip({
  tone = 'default',
  filled = false,
  dot = false,
  status,
  statusLabel,
  title,
  children,
}: ChipProps) {
  const semantic = SEMANTIC.has(tone);
  const pill = (semantic && !filled) || (tone === 'muted' && dot);
  return (
    <span
      className={cx(
        styles.chip,
        pill ? styles.pill : semantic ? styles.tinted : styles[tone]
      )}
      data-tone={tone}
      data-filled={semantic && filled ? '' : undefined}
      title={title}
    >
      {pill && status === undefined ? (
        <span className={styles.dot} aria-hidden="true" />
      ) : null}
      {status !== undefined ? (
        <span className={styles.mark}>
          <StatusMark status={status} label={statusLabel ?? status} />
        </span>
      ) : null}
      <span className={styles.text}>{children}</span>
    </span>
  );
}
