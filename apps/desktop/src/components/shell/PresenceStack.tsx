import type { PresenceEntry } from '@dispatch/client';

import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

interface PresenceStackProps {
  presence: PresenceEntry[];
  /** A task's title by id, so the tooltip can say what someone has open in
   *  words rather than an id. Absent, the id is shown. */
  taskTitle?: (id: string) => string | undefined;
  className?: string;
  /** Makes each face a button that opens that person (Two views' person peek). */
  onOpenPerson?: (ref: string) => void;
}

// At most this many initials before collapsing the rest into "+N". Three
// fits the 36px strip at any window width the app supports; past that a
// row of letters stops being glanceable, which is the strip's whole job.
const MAX_SHOWN = 3;

/** Up to two letters from a handle, for the chip. Handles are
 *  `[a-z0-9._-]`, so splitting on the separators gives a sensible "AL" for
 *  `ada.lovelace` and "AD" for plain `ada`. */
export function initialsFor(handle: string): string {
  const parts = handle.split(/[._-]+/).filter((p) => p !== '');
  const letters =
    parts.length >= 2 ? `${parts[0][0]}${parts[1][0]}` : handle.slice(0, 2);
  return letters.toUpperCase();
}

/** One line of tooltip per person: who, since when, what they are running,
 *  and what they have open — what someone hovering the stack is asking. */
export function presenceLine(
  entry: PresenceEntry,
  taskTitle: (id: string) => string | undefined = () => undefined
): string {
  const since = new Date(entry.since).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const running =
    entry.runs.length === 0
      ? 'not running anything'
      : `running ${entry.runs.length} ${entry.runs.length === 1 ? 'agent' : 'agents'}`;
  const viewing =
    entry.viewing === null
      ? ''
      : `, viewing ${taskTitle(entry.viewing) ?? entry.viewing}`;
  return `${entry.handle} — here since ${since}, ${running}${viewing}`;
}

/**
 * Who else is on this daemon, as a row of initials on the status strip.
 *
 * Renders nothing when only one person is present. That is every solo
 * project, and a lone chip reading "you are here" is noise; the stack earns
 * its place the moment a teammate connects with their own token.
 */
export function PresenceStack({
  presence,
  taskTitle,
  className,
  onOpenPerson,
}: PresenceStackProps) {
  if (presence.length < 2) return null;
  const shown = presence.slice(0, MAX_SHOWN);
  const hidden = presence.length - shown.length;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-slot="presence-stack"
            tabIndex={0}
            role="group"
            aria-label={`${presence.length} people here`}
            className={cn(
              'focus-visible:ring-ring flex items-center rounded-full outline-none focus-visible:ring-2',
              className
            )}
          />
        }
      >
        {shown.map((entry, i) => {
          const face = cn(
            'bg-surface-quaternary border-border-chip flex size-5 items-center justify-center rounded-full border text-[9px] font-medium',
            i > 0 && 'ml-0.5',
            entry.runs.length > 0 && 'ring-state-review ring-1'
          );
          return onOpenPerson !== undefined ? (
            <button
              key={entry.handle}
              type="button"
              aria-label={`Open ${entry.handle}`}
              onClick={() => onOpenPerson(entry.ref)}
              className={cn(face, 'hover:bg-surface-hover')}
            >
              {initialsFor(entry.handle)}
            </button>
          ) : (
            <span
              key={entry.handle}
              aria-hidden
              className={cn(
                'bg-surface-quaternary border-border-chip flex size-5 items-center justify-center rounded-full border text-[9px] font-medium',
                // Side by side, not overlapped: two-letter initials stacked
                // over each other read as one run-together word, not two people.
                i > 0 && 'ml-0.5',
                // A ring on anyone with a live agent, so "who is busy" reads
                // without opening the tooltip.
                entry.runs.length > 0 && 'ring-state-review ring-1'
              )}
            >
              {initialsFor(entry.handle)}
            </span>
          );
        })}
        {hidden > 0 && (
          <span aria-hidden className="text-muted-foreground ml-1">
            +{hidden}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent side="top">
        <ul className="flex flex-col gap-0.5">
          {presence.map((entry) => (
            <li key={entry.handle}>{presenceLine(entry, taskTitle)}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

interface AlsoViewingProps {
  /** Everyone else with this task open — the caller leaves out this window's
   *  own person. */
  viewers: PresenceEntry[];
}

/**
 * Who else has this task open, as initials in the task header. The question
 * it answers is "am I about to trip over someone" — two people editing one
 * task's body, or both about to dispatch it — so it shows only when the
 * answer is yes.
 */
export function AlsoViewing({ viewers }: AlsoViewingProps) {
  if (viewers.length === 0) return null;
  const names = viewers.map((v) => v.handle);
  const sentence =
    names.length === 1
      ? `${names[0]} also has this open`
      : `${names.slice(0, -1).join(', ')} and ${names.at(-1)} also have this open`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-slot="also-viewing"
            tabIndex={0}
            role="group"
            aria-label={sentence}
            className="focus-visible:ring-ring flex items-center rounded-full outline-none focus-visible:ring-2"
          />
        }
      >
        {viewers.slice(0, MAX_SHOWN).map((v, i) => (
          <span
            key={v.handle}
            aria-hidden
            className={cn(
              'bg-surface-quaternary border-border-chip flex size-5 items-center justify-center rounded-full border text-[9px] font-medium',
              i > 0 && 'ml-0.5'
            )}
          >
            {initialsFor(v.handle)}
          </span>
        ))}
      </TooltipTrigger>
      <TooltipContent side="bottom">{sentence}</TooltipContent>
    </Tooltip>
  );
}
