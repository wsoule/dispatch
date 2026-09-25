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
import { cn } from '@/lib/utils';
import { Panel, PanelRow } from '@/ui/chrome';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

export { OPERATOR_ONLY };

// The enclosing group's lock reason, or null while it is unlocked. A row lock
// that would say the same thing is left off.
const GroupLockContext = createContext<string | null>(null);

/** Whether the enclosing group is locked. A disabled fieldset does not reach
 *  Base UI's Switch (a span), so every switch in a group reads this too. */
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
        className={cn(
          'flex flex-col gap-2',
          searching && '[&:not(:has([data-settings-row]))]:hidden',
          className
        )}
      >
        <div className="flex flex-col gap-0.5 px-0.5">
          <div className="flex items-center gap-1.5">
            <h2 className="text-foreground text-[13px] font-semibold">
              {title}
            </h2>
            {locked && <LockedMark reason={access.decideReason} />}
          </div>
          {hint !== undefined && <SettingsHint>{hint}</SettingsHint>}
        </div>
        {/* A disabled fieldset disables the native controls inside it
            (inputs, buttons, the Select trigger). Switches render a span it
            cannot reach, so they read useGroupLocked() instead. */}
        <fieldset disabled={locked} className="m-0 min-w-0 border-0 p-0">
          <GroupLockContext.Provider
            value={locked ? access.decideReason : null}
          >
            <Panel>{children}</Panel>
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

/** Explanatory prose beside a settings control: 12px muted. */
export function SettingsHint({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        'font-book text-muted-foreground text-[12px] leading-[17px]',
        className
      )}
    >
      {children}
    </p>
  );
}

/** A lock beside a setting the viewer may read but not change. */
function LockedMark({ reason }: { reason: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={reason}
            className="text-muted-foreground inline-flex shrink-0"
          />
        }
      >
        <LockIcon aria-hidden className="size-3" />
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{reason}</TooltipContent>
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
  const titleClass = 'text-foreground text-[13px] font-medium';
  const text = (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
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
    <PanelRow
      data-settings-row=""
      className={cn('min-h-11 flex-col items-stretch gap-2 py-2.5', className)}
    >
      <div
        className={cn(
          'flex gap-4',
          stacked ? 'flex-col gap-2' : 'items-center justify-between'
        )}
      >
        {text}
        {control !== undefined && (
          <div
            className={cn(
              'flex shrink-0 items-center gap-2',
              stacked && 'w-full'
            )}
          >
            {control}
          </div>
        )}
      </div>
      {children}
    </PanelRow>
  );
}
