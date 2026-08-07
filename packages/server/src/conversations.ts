import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { conversationPath } from './orchestrator/paths.js';

/** What a conversation is attached to. Not every surface has a run. */
export type SubjectRef =
  | `run:${string}`
  | `worktree:${string}`
  | `pr:${string}`;

const SUBJECT_PREFIXES = ['run:', 'worktree:', 'pr:'] as const;

export function isSubjectRef(value: unknown): value is SubjectRef {
  if (typeof value !== 'string') return false;
  return SUBJECT_PREFIXES.some(
    (prefix) => value.startsWith(prefix) && value.length > prefix.length
  );
}

export interface Snippet {
  file: string;
  startLine: number;
  endLine: number;
  /** The code as it read when attached, so the message survives the branch moving. */
  text: string;
}

export interface ChatMessage {
  id: string;
  role: 'human' | 'agent';
  body: string;
  snippets: Snippet[];
  /** Which target a human message was sent to; absent on an agent reply. */
  target?: string;
  created: string;
}

/**
 * A snippet as stored. Guards the two places untrusted JSON becomes one — a request body and a
 * conversation file on disk — because a malformed snippet is not caught anywhere downstream and
 * renders on a chip as `undefined (undefined-undefined)`.
 */
export function isSnippet(value: unknown): value is Snippet {
  if (typeof value !== 'object' || value === null) return false;
  const snippet = value as Record<string, unknown>;
  return (
    typeof snippet.file === 'string' &&
    typeof snippet.text === 'string' &&
    typeof snippet.startLine === 'number' &&
    Number.isInteger(snippet.startLine) &&
    snippet.startLine >= 0 &&
    typeof snippet.endLine === 'number' &&
    Number.isInteger(snippet.endLine) &&
    snippet.endLine >= 0
  );
}

/** A stored message, checked field by field — see `isSnippet` for why the cast it replaces was
 * not enough. */
export function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    typeof message.id === 'string' &&
    (message.role === 'human' || message.role === 'agent') &&
    typeof message.body === 'string' &&
    typeof message.created === 'string' &&
    Array.isArray(message.snippets) &&
    message.snippets.every(isSnippet) &&
    (message.target === undefined || typeof message.target === 'string')
  );
}

export interface AddMessageInput {
  role: 'human' | 'agent';
  body: string;
  snippets: Snippet[];
  target?: string;
}

/**
 * A working conversation about code, stored per subject.
 *
 * Deliberately separate from ReviewCommentStore: comments are the review record — batched until
 * submit and carried to the agent by formatCommentsForAgent — while this is immediate and never
 * reaches a send-back on its own. Collapsing them would cost reviews their batched-until-submit
 * property.
 */
export class ConversationStore {
  constructor(private readonly rootDir: string) {}

  private file(subject: SubjectRef): string {
    return conversationPath(this.rootDir, subject);
  }

  /**
   * The stored messages, plus how many entries were dropped as malformed. The write paths need
   * that count: they persist this filtered list, so a bad entry that merely read as absent
   * before is deleted for good on the next write.
   */
  private read(subject: SubjectRef): {
    messages: ChatMessage[];
    dropped: number;
  } {
    const path = this.file(subject);
    if (!existsSync(path)) return { messages: [], dropped: 0 };
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!Array.isArray(parsed)) return { messages: [], dropped: 0 };
      // Filtered, not cast: a hand-edited or half-written file otherwise reaches the UI as a
      // message with missing fields, which renders as `undefined` rather than failing loudly.
      const messages = parsed.filter(isChatMessage);
      return { messages, dropped: parsed.length - messages.length };
    } catch {
      // A corrupt file degrades to "no conversation" rather than taking the daemon down, the
      // same way every other per-run artifact here behaves.
      return { messages: [], dropped: 0 };
    }
  }

  list(subject: SubjectRef): ChatMessage[] {
    return this.read(subject).messages;
  }

  // Reading past a malformed entry is recoverable; writing without it is not, so the one write
  // that discards it says so rather than deleting the reviewer's data silently.
  private reportDropped(subject: SubjectRef, dropped: number): void {
    if (dropped === 0) return;
    console.error(
      `dispatchd: dropping ${dropped} malformed message(s) from ${subject} — they are removed from the stored conversation by this write`
    );
  }

  private write(subject: SubjectRef, messages: ChatMessage[]): void {
    const path = this.file(subject);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(messages, null, 2)}\n`);
  }

  add(
    subject: SubjectRef,
    input: AddMessageInput,
    now = new Date().toISOString()
  ): ChatMessage {
    const message: ChatMessage = {
      id: `cm-${randomBytes(3).toString('hex')}`,
      role: input.role,
      body: input.body,
      snippets: input.snippets,
      ...(input.target !== undefined ? { target: input.target } : {}),
      created: now,
    };
    const { messages, dropped } = this.read(subject);
    this.reportDropped(subject, dropped);
    messages.push(message);
    this.write(subject, messages);
    return message;
  }

  remove(subject: SubjectRef, messageId: string): void {
    const { messages, dropped } = this.read(subject);
    this.reportDropped(subject, dropped);
    this.write(
      subject,
      messages.filter((m) => m.id !== messageId)
    );
  }
}
