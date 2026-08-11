// The notification inbox: a persisted, per-project record of the same run/queue transitions
// that fire a transient OS toast (see notificationEdges.ts). The motivating bug was a "merge
// blocked" toast the user had no way to see again and nothing clickable — this is the
// recoverable record; toasts stay as transient mirrors of what lands here. Pure and
// relative-import only so it stays bun-test-able without any DOM/React runtime.

import type { ProjectView } from './appNav';

/** Where clicking an inbox row should take you — mirrors the run/queue transitions
 * `notificationEdges.ts` detects. `runs-page` covers anything that isn't a specific run
 * (e.g. a queue-wide event with no single run to focus). */
export type InboxTarget =
  | { kind: 'run'; runId: string }
  | { kind: 'queue' }
  | { kind: 'runs-page' }
  | { kind: 'task'; taskId: string }
  | { kind: 'draft'; draftId: string }
  | { kind: 'plan'; planId: string };

/**
 * The page a notification row opens, for the targets that name a page rather
 * than one record. `null` for `run`/`task`/`draft`, which App.tsx routes by id
 * instead.
 *
 * Lives here rather than inline in App.tsx so a test pins the destination.
 * When the shell moves a surface, a stale destination is otherwise silent —
 * the click just quietly lands on the wrong page.
 */
export function projectViewForInboxTarget(
  target: InboxTarget
): ProjectView | null {
  switch (target.kind) {
    case 'plan':
      // Plans render one conversation at a time, so the view itself is the
      // destination — there is no per-plan id to select once you are there.
      return 'plans';
    case 'queue':
    case 'runs-page':
      // Both are merge-queue outcomes: queue state transitions
      // (notificationEdges.ts) and drain-push results. Queue state, a held
      // entry's Retry, and the push-failure banner all live on the Landing
      // table.
      return 'landing';
    default:
      return null;
  }
}

export interface InboxEntry {
  /** `${ts}:${title}`, with a numeric suffix appended when that base collides with another
   * entry already in the state — see `uniqueId` below. Stable enough for React keys and for
   * `localStorage` round-tripping without a separate id generator/counter. */
  id: string;
  ts: string;
  title: string;
  body: string;
  target: InboxTarget;
  read: boolean;
}

/** What a caller hands to `addEntries` — everything about a new inbox row except the fields
 * `addEntries` itself owns (`id`, always-unread `read`). */
export type InboxEntryDraft = Omit<InboxEntry, 'id' | 'read'>;

export interface InboxState {
  /** Newest first, capped at `MAX_ENTRIES`. */
  entries: InboxEntry[];
}

const EMPTY_INBOX: InboxState = { entries: [] };

const MAX_ENTRIES = 100;

// Appends a numeric suffix to `base` until it no longer collides with an id already in
// `used` — two events landing in the same diff pass can share both `ts` (they're stamped
// together) and `title` (e.g. two runs finishing at once), so the plain `${ts}:${title}`
// id isn't collision-safe on its own.
function uniqueId(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}:${suffix}`)) suffix++;
  return `${base}:${suffix}`;
}

/**
 * Appends `adds` to `state` as new, unread entries, newest first, capped at `MAX_ENTRIES`.
 * Each add gets a collision-safe id derived from its own `ts`/`title` (see `uniqueId`) rather
 * than a monotonic counter, so ids stay stable across a load/save round-trip instead of
 * depending on process-lifetime state. Returns `state` unchanged (same reference) for an
 * empty `adds` so callers can skip a pointless persist.
 */
export function addEntries(
  state: InboxState,
  adds: InboxEntryDraft[]
): InboxState {
  if (adds.length === 0) return state;

  const used = new Set(state.entries.map((e) => e.id));
  // Built in the order `adds` was given (oldest-of-the-batch first), then reversed below so
  // the batch's own newest-first order matches how it prepends onto the existing newest-first
  // list.
  const newEntries: InboxEntry[] = adds.map((add) => {
    const base = `${add.ts}:${add.title}`;
    const id = uniqueId(base, used);
    used.add(id);
    return { ...add, id, read: false };
  });

  return {
    entries: [...newEntries.reverse(), ...state.entries].slice(0, MAX_ENTRIES),
  };
}

/** Flips every entry to read — fired once when the inbox panel opens, not per-entry (an
 * unread badge that decremented per-row as you skimmed the list would be more distracting
 * than useful). Returns `state` unchanged when everything is already read. */
export function markAllRead(state: InboxState): InboxState {
  if (state.entries.every((e) => e.read)) return state;
  return {
    entries: state.entries.map((e) => (e.read ? e : { ...e, read: true })),
  };
}

/** Count of unread entries — the sidebar bell's badge. */
export function unreadCount(state: InboxState): number {
  return state.entries.reduce((count, e) => (e.read ? count : count + 1), 0);
}

// One inbox per project root, so switching projects never shows a different project's
// notifications (or worse, lets marking one project's inbox read clear another's).
function storageKey(root: string): string {
  return `dispatch:inbox:${root}`;
}

/**
 * Reads the persisted inbox for `root`, or an empty inbox if nothing's stored yet or the
 * stored value fails to parse as the expected shape — a corrupt/foreign value under this key
 * must never crash the app on load, it should just look like a fresh inbox. `storage` is
 * narrowed to `Pick<Storage, 'getItem'>` so callers can pass `localStorage` directly while
 * tests pass a plain stub object.
 */
export function loadInbox(
  root: string,
  storage: Pick<Storage, 'getItem'>
): InboxState {
  const raw = storage.getItem(storageKey(root));
  if (raw === null) return EMPTY_INBOX;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as InboxState).entries)
    ) {
      return EMPTY_INBOX;
    }
    return parsed as InboxState;
  } catch {
    return EMPTY_INBOX;
  }
}

/**
 * Persists `state` for `root`. `storage` is narrowed to `Pick<Storage, 'setItem'>` for the
 * same testability reason as `loadInbox`. `setItem` can throw (quota exceeded, or Safari
 * private browsing rejects `localStorage` writes outright) — this is called from inside a
 * React state updater (see useDispatchProject's `updateInbox`), where an uncaught throw would
 * propagate out of the updater and crash the render, so a failed persist is swallowed with a
 * warning rather than losing the whole inbox update.
 */
export function saveInbox(
  root: string,
  state: InboxState,
  storage: Pick<Storage, 'setItem'>
): void {
  try {
    storage.setItem(storageKey(root), JSON.stringify(state));
  } catch (err) {
    console.warn('dispatch: failed to persist notification inbox', err);
  }
}
