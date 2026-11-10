import type { PresenceEntry } from '@dispatch/client';
import { cx, InitialsAvatar, Tooltip } from '@dispatch/ui';

import styles from './PresenceStack.module.css';

interface PresenceStackProps {
  presence: PresenceEntry[];
  /** A task's title by id, so the tooltip can say what someone has open in
   *  words rather than an id. Absent, the id is shown. */
  taskTitle?: (id: string) => string | undefined;
  className?: string;
  /** Makes each face a button that opens that person's peek (a drawer over the view). */
  onOpenPerson?: (ref: string) => void;
}

// At most this many faces before collapsing the rest into "+N". Three
// fits the 36px strip at any window width the app supports; past that a
// row of faces stops being glanceable, which is the strip's whole job.
const MAX_SHOWN = 3;

/** The name an avatar reads its initials from: a handle's separators
 *  (`[._-]`) as spaces, so `ada.lovelace` reads "AL" and `ada` reads "A". */
function avatarName(handle: string): string {
  return handle.replace(/[._-]+/g, ' ');
}

/** One person's face: their avatar with the handle beside it for screen
 *  readers (so a name is never initials only), ringed in the info hue
 *  while they have a live agent. */
function Face({ entry }: { entry: PresenceEntry }) {
  return (
    <>
      <span
        className={styles.ring}
        data-tone={entry.runs.length > 0 ? 'info' : undefined}
        aria-hidden="true"
      >
        <InitialsAvatar name={avatarName(entry.handle)} size="sm" />
      </span>
      <span className="srOnly">{entry.handle}</span>
    </>
  );
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
 * Who else is on this daemon, as a row of avatars in the topbar.
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
    <Tooltip
      side="bottom"
      content={
        <ul className={styles.lines}>
          {presence.map((entry) => (
            <li key={entry.handle}>{presenceLine(entry, taskTitle)}</li>
          ))}
        </ul>
      }
    >
      <span
        data-slot="presence-stack"
        tabIndex={0}
        role="group"
        aria-label={`${presence.length} people here`}
        className={cx(styles.stack, className)}
      >
        {shown.map((entry) =>
          onOpenPerson !== undefined ? (
            <button
              key={entry.handle}
              type="button"
              aria-label={`Open ${entry.handle}`}
              onClick={() => onOpenPerson(entry.ref)}
              className={styles.face}
            >
              <Face entry={entry} />
            </button>
          ) : (
            // Side by side, not overlapped, and ringed while that person has a live agent.
            <span key={entry.handle} className={styles.face}>
              <Face entry={entry} />
            </span>
          )
        )}
        {hidden > 0 && (
          <span aria-hidden="true" className={styles.more}>
            +{hidden}
          </span>
        )}
      </span>
    </Tooltip>
  );
}

interface AlsoViewingProps {
  /** Everyone else with this task open — the caller leaves out this window's
   *  own person. */
  viewers: PresenceEntry[];
}

/**
 * Who else has this task open, as avatars in the task header. The question
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
    <Tooltip side="bottom" content={sentence}>
      <span
        data-slot="also-viewing"
        tabIndex={0}
        role="group"
        aria-label={sentence}
        className={styles.stack}
      >
        {viewers.slice(0, MAX_SHOWN).map((v) => (
          <span key={v.handle} className={styles.face}>
            <Face entry={v} />
          </span>
        ))}
      </span>
    </Tooltip>
  );
}
