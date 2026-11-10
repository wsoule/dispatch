'use client';

import {
  CircleAlert,
  CircleCheck,
  Info,
  type LucideIcon,
  TriangleAlert,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { Link } from '../lib/link';
import type { UiTone } from '../types';
import styles from './alert-strip.module.css';
import { cx } from './render';
import type { AlertStripProps } from './types';

/* The leading icon per tone, Gr8r's alert glyphs: danger a circled "!",
   warning a triangle, success a circled tick, anything else an "i". */
const TONE_ICON: Record<UiTone, LucideIcon> = {
  danger: CircleAlert,
  warning: TriangleAlert,
  success: CircleCheck,
  info: Info,
  accent: Info,
  default: Info,
  muted: Info,
};

/* Gr8r's alert: a 14px icon in the tone's hue, a lead-in word and one
   sentence, with an optional follow-up ("Overdue by 3 days. Reschedule"),
   in a box tinted by `tone` (data-tone, docs/architecture.md §8.2): the
   tone's soft fill with the icon in its hue and the lead-in in its text
   colour, or a bordered neutral box for default / muted. The default is
   warning: an alert is always a status, so a caller that forgets its tone
   gets amber, never the purple accent. `plain` drops the box (no fill, no
   border) for a row of a neutral list of alerts, where only the icon and
   the lead-in carry the tone and the sentence is --text-2. The follow-up
   is a link in the accent (underlined, so not told by colour alone); it is
   a link when it goes somewhere and a button when it acts in place (e.g.
   focusing the date field). */
export default function AlertStrip({
  label = 'Alert',
  tone = 'warning',
  plain = false,
  children,
  action,
}: AlertStripProps): ReactNode {
  const Icon = TONE_ICON[tone] ?? Info;
  return (
    <div className={cx(styles.strip, plain && styles.plain)} data-tone={tone}>
      <span className={styles.lead}>
        <Icon
          className={styles.icon}
          size={14}
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <span className={styles.key}>{label}</span>
      </span>
      <p className={styles.text}>
        {children}
        {action !== undefined ? (
          <>
            {' '}
            {action.href !== undefined ? (
              <Link
                href={action.href}
                className={styles.action}
                onClick={action.onClick}
              >
                {action.label}
              </Link>
            ) : (
              <button
                type="button"
                className={styles.action}
                onClick={action.onClick}
              >
                {action.label}
              </button>
            )}
          </>
        ) : null}
      </p>
    </div>
  );
}
