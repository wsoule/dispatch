import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// The Dispatch "hub for notes and data agents create" (product vision): lightweight items an
// agent or the user jots down that aren't yet tasks — a triage an agent found ("this file is
// huge, refactor it"), a follow-up to do after a merge, a free-form note, or a personal todo.
// Any of them can be promoted into a real task later. Stored as one git-native JSON file at
// `.dispatch/notes.json` (a single file rather than one-per-note: notes are lighter and more
// numerous than tasks, and a flat list is all the UI ever needs to render).

export type NoteKind = 'note' | 'triage' | 'followup' | 'todo';

export const NOTE_KINDS: readonly NoteKind[] = [
  'note',
  'triage',
  'followup',
  'todo',
];

export interface Note {
  id: string;
  kind: NoteKind;
  title: string;
  body: string;
  done: boolean;
  /** Set once this note has been promoted into a task, to the new task's id. */
  linkedTaskId: string | null;
  /** The agent run that created it, if any — so the UI can show "an agent flagged this". */
  createdByRunId: string | null;
  created: string;
  updated: string;
}

export interface CreateNoteInput {
  kind: NoteKind;
  title: string;
  body?: string;
  createdByRunId?: string | null;
}

export interface UpdateNotePatch {
  title?: string;
  body?: string;
  kind?: NoteKind;
  done?: boolean;
  linkedTaskId?: string | null;
}

function generateNoteId(): string {
  return `nt-${randomBytes(3).toString('hex')}`;
}

/**
 * A flat, JSON-file-backed store for notes/triage/follow-ups/todos. Every mutation rewrites
 * `.dispatch/notes.json` atomically-ish (whole-file write) and returns the affected note, so
 * the daemon can broadcast a change and clients refetch — the same read-through model the task
 * cache uses, just simpler because notes have no cross-file graph to maintain.
 */
export class NoteStore {
  private readonly file: string;

  constructor(rootDir: string) {
    this.file = join(rootDir, '.dispatch', 'notes.json');
  }

  private read(): Note[] {
    if (!existsSync(this.file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      return Array.isArray(parsed) ? (parsed as Note[]) : [];
    } catch {
      // A corrupt/hand-mangled notes file degrades to "no notes" rather than crashing the
      // daemon — the same tolerance the task cache gives a bad task file.
      return [];
    }
  }

  private write(notes: Note[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(notes, null, 2)}\n`);
  }

  list(): Note[] {
    // Newest first — the hub reads like a feed of what's been captured lately.
    return this.read().sort((a, b) => b.created.localeCompare(a.created));
  }

  get(id: string): Note | null {
    return this.read().find((n) => n.id === id) ?? null;
  }

  create(input: CreateNoteInput, now = new Date().toISOString()): Note {
    const note: Note = {
      id: generateNoteId(),
      kind: input.kind,
      title: input.title,
      body: input.body ?? '',
      done: false,
      linkedTaskId: null,
      createdByRunId: input.createdByRunId ?? null,
      created: now,
      updated: now,
    };
    const notes = this.read();
    notes.push(note);
    this.write(notes);
    return note;
  }

  update(
    id: string,
    patch: UpdateNotePatch,
    now = new Date().toISOString()
  ): Note {
    const notes = this.read();
    const note = notes.find((n) => n.id === id);
    if (note === undefined) throw new Error(`note not found: ${id}`);
    // Drop undefined entries so a partial patch never blanks a field.
    const fields = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined)
    );
    Object.assign(note, fields, { updated: now });
    this.write(notes);
    return note;
  }

  delete(id: string): void {
    const notes = this.read();
    const next = notes.filter((n) => n.id !== id);
    if (next.length === notes.length) throw new Error(`note not found: ${id}`);
    this.write(next);
  }
}
