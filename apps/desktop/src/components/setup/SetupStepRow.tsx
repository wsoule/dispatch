import type { SetupStatus } from '@dispatch-foo/core/browser';
import { cx, Spinner, type UiTone } from '@dispatch/ui';
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  type LucideIcon,
} from 'lucide-react';
import { type ReactNode, useId } from 'react';

import { RawDetails } from '../gr8r/RawText';
import styles from './setup.module.css';

type GlyphStatus = SetupStatus | 'waiting';

/* Each status's mark: a distinct lucide shape (so forced colours, which drop the hue,
   still tell them apart), its spoken name, and the tone that colours it. */
const GLYPHS: Record<
  GlyphStatus,
  { icon: LucideIcon; label: string; tone: UiTone }
> = {
  ok: { icon: CircleCheck, label: 'Done', tone: 'success' },
  'needs-action': { icon: CircleAlert, label: 'Needs you', tone: 'warning' },
  missing: { icon: CircleAlert, label: 'Needs you', tone: 'warning' },
  unknown: { icon: CircleHelp, label: "Couldn't check", tone: 'muted' },
  waiting: { icon: CircleDashed, label: 'Not yet', tone: 'muted' },
};

interface SetupStepRowProps {
  status: GlyphStatus | 'checking';
  title: string;
  message: string;
  /** Primary fix button(s), shown on the right. */
  action?: ReactNode;
  detail?: string;
  /** Extra controls under the message (identity form, provider list). */
  children?: ReactNode;
}

/* The step's status mark: a toned icon named for assistive tech, or a Spinner while the
   machine is being probed (in-flight work; the message beside it says "Checking…"). */
function StepGlyph({ status }: { status: GlyphStatus | 'checking' }) {
  if (status === 'checking') {
    return (
      <span className={styles.glyph}>
        <Spinner size="sm" label="" />
      </span>
    );
  }
  const { icon: Icon, label, tone } = GLYPHS[status];
  return (
    <span
      role="img"
      aria-label={label}
      className={cx(styles.glyph, 'toneText')}
      data-tone={tone}
    >
      <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
    </span>
  );
}

/** One line of the setup checklist: a section named by its h2, with its fix buttons on
    the right and any extra controls and raw details under the message. */
export function SetupStepRow({
  status,
  title,
  message,
  action,
  detail,
  children,
}: SetupStepRowProps) {
  const titleId = useId();
  return (
    <section className={styles.step} aria-labelledby={titleId}>
      <div className={styles.head}>
        <StepGlyph status={status} />
        <div className={styles.headBody}>
          <div className={styles.text}>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            <p className={styles.message}>{message}</p>
          </div>
          {action !== undefined && (
            <div className={styles.actions}>{action}</div>
          )}
        </div>
      </div>
      {(children !== undefined || detail !== undefined) && (
        <div className={styles.extra}>
          {children}
          {detail !== undefined && <RawDetails text={detail} />}
        </div>
      )}
    </section>
  );
}
