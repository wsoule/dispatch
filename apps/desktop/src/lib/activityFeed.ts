import { parseActorRef } from '@dispatch-foo/core/browser';

// A task's `## Activity` section as a feed. Every line is `- <text>` (core's appendActivity),
// where the orchestrator prefixes its own lines with an ISO timestamp (`dispatched (…)`,
// `[run r-1] …`) and a comment — an agent's task_comment or a note from the composer —
// carries ` — <actor>` at the end. The page draws the two differently: events are one-line
// timeline rows, comments are cards.

export interface ActivityEntry {
  /** The ISO timestamp the line opened with, or `null` for an older, undated note. */
  at: string | null;
  text: string;
  /** The serialized ActorRef the line was credited to (`human`, `agent:ai/claude`), or `null`. */
  actor: string | null;
  kind: 'event' | 'comment';
}

// `— human:wyat` / `— agent:wyat/claude` / `— none`, at the very end of the line.
const ACTOR_SUFFIX = /\s—\s([a-z0-9:/._-]+)$/;
const LEADING_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s+/;

// A well-formed ActorRef wire value, `none` included — anything else after an em dash is
// just prose.
function isActorRef(candidate: string): boolean {
  try {
    parseActorRef(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Whether an actor suffix names a person or an agent — the only lines that are comments. */
function isAttributed(actor: string | null): boolean {
  return actor !== null && actor !== 'none';
}

/** One Activity line → its entry. Undated, unattributed lines are the notes the desktop
 * used to append verbatim, so they read as comments rather than system events. */
export function parseActivityLine(line: string): ActivityEntry {
  let text = line.replace(/^\s*[-*]\s+/, '').trim();
  let actor: string | null = null;
  const actorMatch = ACTOR_SUFFIX.exec(text);
  if (actorMatch?.[1] !== undefined && isActorRef(actorMatch[1])) {
    actor = actorMatch[1];
    text = text.slice(0, actorMatch.index).trimEnd();
  }
  let at: string | null = null;
  const timeMatch = LEADING_TIMESTAMP.exec(text);
  if (timeMatch?.[1] !== undefined) {
    at = timeMatch[1];
    text = text.slice(timeMatch[0].length);
  }
  const kind: ActivityEntry['kind'] =
    isAttributed(actor) || (at === null && actor === null)
      ? 'comment'
      : 'event';
  return { at, text, actor, kind };
}

/** Whether a line opens a new bullet (`- …` / `* …`) rather than continuing the last one. */
function isBulletLine(line: string): boolean {
  return /^\s*[-*]\s+/.test(line);
}

/**
 * The whole section, oldest first, blank lines dropped. A multi-line comment is one bullet
 * whose later lines carry no marker (core's appendActivity keeps the newlines and puts the
 * actor suffix after the last line), so continuation lines are folded back into the entry
 * they belong to before the actor and timestamp are read.
 */
export function parseActivity(section: string): ActivityEntry[] {
  const entries: string[] = [];
  for (const line of section.split('\n')) {
    if (line.trim() === '') continue;
    const last = entries.length - 1;
    if (isBulletLine(line) || last < 0) entries.push(line);
    else entries[last] = `${entries[last]}\n${line}`;
  }
  return entries.map(parseActivityLine);
}
