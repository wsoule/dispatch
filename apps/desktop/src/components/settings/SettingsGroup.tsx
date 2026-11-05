import { cx, Tooltip, type UiTone } from '@dispatch/ui';
import { LockIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';

import { OPERATOR_ONLY, useSettingsAccess } from './access';
import {
  nodeText,
  SearchScopeProvider,
  useScopeMatched,
  useSearching,
  useSearchVisible,
} from './search';
import styles from './settings.module.css';

export { OPERATOR_ONLY };

// The enclosing group's lock reason, or null while it is unlocked. A row lock
// that would say the same thing is left off.
const GroupLockContext = createContext<string | null>(null);

/** Whether the enclosing group is locked, for controls that keep their own disabled
 *  state rather than reading the disabled fieldset around them. */
export function useGroupLocked(): boolean {
  return useContext(GroupLockContext) !== null;
}

interface SettingsGroupProps {
  /** The section heading above the card. */
  title: string;
  /** One short line of context under the heading. */
  hint?: ReactNode;
  /** Extra words search should match this whole group on. */
  keywords?: string;
  /**
   * What changing anything in this group needs. Every config save needs the
   * decide tier, so that is the default and a group only opts out (`none`)
   * when its controls hit routes of their own: Linear's connect and sync,
   * Sync now, team invites, the license, or nothing at all.
   */
  requires?: 'decide' | 'none';
  children: ReactNode;
  className?: string;
}

/** A settings section: a heading, an optional line of context, then the card
 *  its rows live in. While searching, a group whose name matches shows every
 *  row, and a group left with no matching rows hides itself. */
export function SettingsGroup({
  title,
  hint,
  keywords,
  requires = 'decide',
  children,
  className,
}: SettingsGroupProps) {
  const searching = useSearching();
  const access = useSettingsAccess();
  const locked = requires === 'decide' && !access.canDecide;
  return (
    <SearchScopeProvider text={`${title} ${keywords ?? ''}`}>
      <section
        data-settings-group=""
        data-searching={searching ? '' : undefined}
        className={cx(styles.group, className)}
      >
        <div className={styles.groupHead}>
          <div className={styles.titleLine}>
            <h2 className={styles.groupTitle}>{title}</h2>
            {locked && <LockedMark reason={access.decideReason} />}
          </div>
          {hint !== undefined && <SettingsHint>{hint}</SettingsHint>}
        </div>
        {/* A disabled fieldset disables the native controls inside it
            (inputs, buttons, switches, the Select trigger). Custom controls
            and segmented choices read useGroupLocked() too. */}
        <fieldset disabled={locked} className={styles.fieldset}>
          <GroupLockContext.Provider
            value={locked ? access.decideReason : null}
          >
            <div className={styles.card}>{children}</div>
          </GroupLockContext.Provider>
        </fieldset>
        <GroupMatchMarker />
      </section>
    </SearchScopeProvider>
  );
}

// Keeps a group visible when it matched by name, even if its content is not
// made of rows (a list, a slider) that would mark it themselves.
function GroupMatchMarker() {
  return useScopeMatched() ? <span data-settings-row="" hidden /> : null;
}

/** Explanatory prose beside a settings control: small and muted. With a
 *  `tone` it is a status line in that tone's text colour (`.toneText`, for
 *  example danger for a refusal); its words still say the status. */
export function SettingsHint({
  children,
  className,
  tone,
}: {
  children: ReactNode;
  className?: string;
  tone?: UiTone;
}) {
  return (
    <p
      className={cx(
        styles.hint,
        tone === undefined ? undefined : 'toneText',
        className
      )}
      data-tone={tone}
    >
      {children}
    </p>
  );
}

/** A lock beside a setting the viewer may read but not change. */
function LockedMark({ reason }: { reason: string }) {
  return (
    <Tooltip content={reason}>
      <span role="img" aria-label={reason} className={styles.lock}>
        <LockIcon aria-hidden size={12} strokeWidth={1.8} />
      </span>
    </Tooltip>
  );
}

interface SettingsRowProps {
  /** 13px/500. Becomes the control's `<label>` when `htmlFor` names it. */
  title: ReactNode;
  /** 12px muted, under the title. */
  subtitle?: ReactNode;
  /** Extra words search should find this row by (synonyms, config keys). */
  keywords?: string;
  htmlFor?: string;
  /** The control, right-aligned: a select pill, a switch, a short input. */
  control?: ReactNode;
  /** Puts the control under the text instead of beside it, for a field that
   *  needs the whole width (a command, a URL, a textarea). */
  stacked?: boolean;
  /** Read-only for this viewer: shows a lock beside the title. `true` means
   *  operator-only; a string is the lock's own reason. */
  locked?: boolean | string;
  /** Free content after the title/control line: an error, a status line. */
  children?: ReactNode;
  className?: string;
}

/** One row of a settings card: title and subtitle on the left, the control on
 *  the right. Hides itself while a search is on that it does not match. */
export function SettingsRow({
  title,
  subtitle,
  keywords,
  htmlFor,
  control,
  stacked = false,
  locked = false,
  children,
  className,
}: SettingsRowProps) {
  const visible = useSearchVisible(
    `${nodeText(title)} ${nodeText(subtitle)} ${keywords ?? ''}`
  );
  const access = useSettingsAccess();
  const groupReason = useContext(GroupLockContext);
  if (!visible) return null;
  const reason =
    typeof locked === 'string' ? locked : locked ? access.operateReason : null;
  const titleClass = styles.rowTitle;
  const text = (
    <div className={styles.rowText}>
      <div className={styles.titleLine}>
        {htmlFor !== undefined ? (
          <label htmlFor={htmlFor} className={titleClass}>
            {title}
          </label>
        ) : (
          <span className={titleClass}>{title}</span>
        )}
        {reason !== null && reason !== groupReason && (
          <LockedMark reason={reason} />
        )}
      </div>
      {subtitle !== undefined && <SettingsHint>{subtitle}</SettingsHint>}
    </div>
  );
  return (
    <div data-settings-row="" className={cx(styles.row, className)}>
      <div className={styles.rowLine} data-stacked={stacked ? '' : undefined}>
        {text}
        {control !== undefined && (
          <div className={styles.rowControl}>{control}</div>
        )}
      </div>
      {children}
    </div>
  );
}
