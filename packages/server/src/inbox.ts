import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The brain-dump inbox: everything you notice, before you decide whether it matters.
 *
 * Stored as markdown at `.dispatch/inbox.md` rather than JSON (the way `notes.json` was),
 * because the whole premise of the surface is that capture must be frictionless — and the
 * cheapest possible capture is opening the file in your editor and typing a line. That means the
 * parser has to accept what a human would plausibly write, not just what this file emits:
 *
 *     - [ ] (bug) diffs go blank mid-run
 *     - [ ] a bare line with no kind at all
 *     - [x] (task) already sorted → t-4a8cce
 *
 * Ids live in a trailing `^in-abc123` marker and are assigned on the next write when missing, so
 * a hand-added line is a first-class item without the user having to invent an id.
 *
 * This store replaces `NoteStore`, so it carries what notes carried: `done`, `linkedTaskId`, and
 * `createdByRunId` — the last one matters because agents flag items mid-run through the MCP
 * `dispatch_note` tool, and "an agent noticed this" has to survive the move.
 */

export type InboxKind = 'bug' | 'idea' | 'task' | 'note';

export const INBOX_KINDS: readonly InboxKind[] = [
  'bug',
  'idea',
  'task',
  'note',
];

function isInboxKind(value: string): value is InboxKind {
  return (INBOX_KINDS as readonly string[]).includes(value);
}

export interface InboxItem {
  id: string;
  kind: InboxKind;
  text: string;
  /** True once this item has been converted or dismissed — it moves to the archive band. */
  done: boolean;
  /** The task this became, when it was converted. */
  linkedTaskId: string | null;
  /** The agent run that flagged it, when an agent did. */
  createdByRunId: string | null;
  created: string;
}

export interface AddInboxInput {
  /** Raw text. Split on newlines into one item per non-empty line. */
  text: string;
  /** Overrides the guess. Omit to let `inferKind` decide per line. */
  kind?: InboxKind;
  createdByRunId?: string | null;
}

function generateId(): string {
  return `in-${randomBytes(3).toString('hex')}`;
}

/**
 * Guess what a captured line is.
 *
 * Deliberately crude, and deliberately local — no model call. A wrong guess the user can change
 * in one click beats a slow one they have to wait for, and the whole point of the inbox is that
 * capture never blocks. Order matters: bug-ish words win over task-ish ones, because "fix the
 * broken thing" is a bug report that happens to contain an imperative.
 */
export function inferKind(text: string): InboxKind {
  if (
    /\b(bug|broken|blank|crash|fail|regress|wrong|leak|eating|stuck|hang)/i.test(
      text
    )
  ) {
    return 'bug';
  }
  if (
    /\b(need|should|add|wire|build|make|implement|support|move|rename)/i.test(
      text
    )
  ) {
    return 'task';
  }
  if (/\b(idea|maybe|what if|consider|could|might|explore)/i.test(text)) {
    return 'idea';
  }
  return 'note';
}

/** One item per non-empty line, trimmed. Bullet and checkbox prefixes a user might paste in
 * are stripped so pasting an existing markdown list does not produce "- - [ ] thing". */
export function splitCapture(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.replace(/^\s*[-*]\s*(\[[ xX]\]\s*)?/, '').trim())
    .filter((line) => line.length > 0);
}

const LINE = /^\s*[-*]\s*\[([ xX])\]\s*(.*)$/;

/** Pulls the trailing markers off an item's text, leaving the prose. */
function parseMarkers(rest: string): {
  text: string;
  kind: InboxKind | null;
  id: string | null;
  linkedTaskId: string | null;
  createdByRunId: string | null;
} {
  let text = rest;
  let id: string | null = null;
  let linkedTaskId: string | null = null;
  let createdByRunId: string | null = null;

  const idMatch = text.match(/\s*\^(in-[0-9a-f]+)\s*$/);
  if (idMatch?.[1] !== undefined) {
    id = idMatch[1];
    text = text.slice(0, idMatch.index).trimEnd();
  }
  const runMatch = text.match(/\s*@(r-[0-9a-z]+)\s*$/i);
  if (runMatch?.[1] !== undefined) {
    createdByRunId = runMatch[1];
    text = text.slice(0, runMatch.index).trimEnd();
  }
  const taskMatch = text.match(/\s*(?:→|->)\s*(t-[0-9a-z]+)\s*$/i);
  if (taskMatch?.[1] !== undefined) {
    linkedTaskId = taskMatch[1];
    text = text.slice(0, taskMatch.index).trimEnd();
  }

  let kind: InboxKind | null = null;
  const kindMatch = text.match(/^\(([a-z]+)\)\s*/i);
  const candidate = kindMatch?.[1]?.toLowerCase();
  if (candidate !== undefined && isInboxKind(candidate)) {
    kind = candidate;
    text = text.slice(kindMatch?.[0].length ?? 0);
  }

  return { text: text.trim(), kind, id, linkedTaskId, createdByRunId };
}

/**
 * Parse the file. Tolerant by design: anything that is not a recognisable item line is skipped
 * rather than throwing, so a hand-edit that breaks the format costs you that line and not the
 * whole inbox — and never takes the daemon down with it.
 */
export function parseInbox(markdown: string): InboxItem[] {
  const items: InboxItem[] = [];
  for (const line of markdown.split('\n')) {
    const m = line.match(LINE);
    const box = m?.[1];
    const rest = m?.[2];
    if (box === undefined || rest === undefined) continue;
    const parsed = parseMarkers(rest);
    if (parsed.text === '') continue;
    items.push({
      // A hand-added line has no id yet; one is minted here and persisted on the next write.
      id: parsed.id ?? generateId(),
      kind: parsed.kind ?? inferKind(parsed.text),
      text: parsed.text,
      done: box.toLowerCase() === 'x',
      linkedTaskId: parsed.linkedTaskId,
      createdByRunId: parsed.createdByRunId,
      // The format carries no timestamp on purpose — it would be noise in a file meant to be
      // typed into. Ordering is file order, which is what a human editing it would expect.
      created: '',
    });
  }
  return items;
}

function serializeItem(item: InboxItem): string {
  const box = item.done ? 'x' : ' ';
  const parts = [`- [${box}] (${item.kind}) ${item.text}`];
  if (item.linkedTaskId !== null) parts.push(`→ ${item.linkedTaskId}`);
  if (item.createdByRunId !== null) parts.push(`@${item.createdByRunId}`);
  parts.push(`^${item.id}`);
  return parts.join(' ');
}

export function serializeInbox(items: InboxItem[]): string {
  const open = items.filter((i) => !i.done);
  const sorted = items.filter((i) => i.done);
  const lines = [
    '# Inbox',
    '',
    'Captured, not committed. Edit this file freely — add a `- [ ] your thought`',
    'line anywhere and Dispatch will pick it up.',
    '',
    '## Open',
    '',
    ...open.map(serializeItem),
    '',
    '## Sorted',
    '',
    ...sorted.map(serializeItem),
    '',
  ];
  return lines.join('\n');
}

export class InboxStore {
  private readonly file: string;

  constructor(rootDir: string) {
    this.file = join(rootDir, '.dispatch', 'inbox.md');
  }

  private read(): InboxItem[] {
    if (!existsSync(this.file)) return [];
    try {
      return parseInbox(readFileSync(this.file, 'utf8'));
    } catch {
      return [];
    }
  }

  private write(items: InboxItem[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, serializeInbox(items));
  }

  /** Open items first, in file order — the inbox reads top-down like the file does. */
  list(): InboxItem[] {
    return this.read();
  }

  /** Splits `text` into one item per line and prepends them, newest capture first. */
  add(input: AddInboxInput): InboxItem[] {
    const lines = splitCapture(input.text);
    if (lines.length === 0) return [];
    const created: InboxItem[] = lines.map((text) => ({
      id: generateId(),
      kind: input.kind ?? inferKind(text),
      text,
      done: false,
      linkedTaskId: null,
      createdByRunId: input.createdByRunId ?? null,
      created: '',
    }));
    const existing = this.read();
    this.write([...created, ...existing]);
    return created;
  }

  update(
    id: string,
    patch: {
      kind?: InboxKind;
      text?: string;
      done?: boolean;
      linkedTaskId?: string | null;
    }
  ): InboxItem {
    const items = this.read();
    const item = items.find((i) => i.id === id);
    if (item === undefined) throw new Error(`inbox item not found: ${id}`);
    if (patch.kind !== undefined) item.kind = patch.kind;
    if (patch.text !== undefined) item.text = patch.text;
    if (patch.done !== undefined) item.done = patch.done;
    if (patch.linkedTaskId !== undefined)
      item.linkedTaskId = patch.linkedTaskId;
    this.write(items);
    return item;
  }

  /** Drops items outright. Used by dismiss — a dismissed thought should not linger. */
  remove(ids: string[]): void {
    const drop = new Set(ids);
    this.write(this.read().filter((i) => !drop.has(i.id)));
  }

  /**
   * Marks items converted, recording which task each became.
   *
   * Idempotent on re-run: an item already linked to a task is left as it is rather than being
   * linked twice, so a retried convert cannot fan one thought out into several tasks.
   */
  markConverted(links: { id: string; taskId: string }[]): InboxItem[] {
    const items = this.read();
    const changed: InboxItem[] = [];
    for (const link of links) {
      const item = items.find((i) => i.id === link.id);
      if (item === undefined) continue;
      if (item.linkedTaskId !== null) continue;
      item.done = true;
      item.linkedTaskId = link.taskId;
      changed.push(item);
    }
    this.write(items);
    return changed;
  }

  /**
   * One-time migration of `.dispatch/notes.json` into the inbox.
   *
   * Notes and inbox items are the same idea with different vocabularies, so the four note kinds
   * fold onto the four inbox kinds. `triage` and `followup` both become `task` — they were
   * always "something to do" — and anything unrecognised becomes `note` rather than being
   * dropped: losing a captured thought is the one outcome worse than mis-filing it.
   *
   * Idempotent: items already carrying a note's id are skipped, so running it twice cannot
   * duplicate. Returns how many it brought across.
   */
  migrateNotes(rootDir: string): number {
    const notesFile = join(rootDir, '.dispatch', 'notes.json');
    if (!existsSync(notesFile)) return 0;

    let notes: unknown;
    try {
      notes = JSON.parse(readFileSync(notesFile, 'utf8'));
    } catch {
      return 0;
    }
    if (!Array.isArray(notes)) return 0;

    const existing = this.read();
    const seen = new Set(existing.map((i) => i.text));
    const KIND: Record<string, InboxKind> = {
      note: 'note',
      triage: 'task',
      followup: 'task',
      todo: 'task',
    };

    const brought: InboxItem[] = [];
    for (const raw of notes) {
      const note = raw as Record<string, unknown>;
      const title = typeof note.title === 'string' ? note.title.trim() : '';
      if (title === '') continue;
      if (seen.has(title)) continue;
      const kindKey = typeof note.kind === 'string' ? note.kind : '';
      brought.push({
        id: generateId(),
        kind: KIND[kindKey] ?? 'note',
        text: title,
        done: note.done === true,
        linkedTaskId:
          typeof note.linkedTaskId === 'string' ? note.linkedTaskId : null,
        createdByRunId:
          typeof note.createdByRunId === 'string' ? note.createdByRunId : null,
        created: '',
      });
      seen.add(title);
    }
    if (brought.length === 0) return 0;
    this.write([...existing, ...brought]);
    return brought.length;
  }
}
