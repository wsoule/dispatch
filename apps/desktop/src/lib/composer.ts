// The Threads composer's pure half: `@` mentions, draft checks, and turning a
// failed send into an inline, field-named problem.
import type { SendInput } from '@dispatch/client';
import { ApiError } from '@dispatch/client';

export type ComposeKind = 'message' | 'question' | 'notice';

/** A new message as the composer holds it. */
export interface ComposeState {
  to: string[];
  body: string;
  kind: ComposeKind;
  urgent: boolean;
  wake: boolean;
}

/** Why a send cannot go; `field` uses the daemon's names (`to[0]`, `body`). */
export interface ComposeProblem {
  field: string;
  message: string;
}

const TRAILING_MENTION = /(^|\s)@([^\s@]*)$/;
const TYPED_ADDRESS = /^[a-z]+:\S+$/;
const INDEXED_FIELD = /^(to|refs|choices)\[(\d+)\]/;
const INDEXED_NOUNS: Record<string, string> = {
  to: 'Recipient',
  refs: 'Reference',
  choices: 'Choice',
};
const FIELD_NAMES: Record<string, string> = {
  to: 'Recipients',
  body: 'Message',
  choice: 'Choice',
  replyTo: 'Reply',
  send: 'Send',
};

/** The `@token` at the end of the draft, where completion applies, or null. */
export function trailingMention(
  body: string
): { start: number; query: string } | null {
  const match = TRAILING_MENTION.exec(body);
  if (match === null) return null;
  return {
    start: match.index + (match[1] ?? '').length,
    query: match[2] ?? '',
  };
}

export function dropTrailingMention(body: string): string {
  const mention = trailingMention(body);
  return mention === null ? body : body.slice(0, mention.start);
}

/** The trailing `@token` as a recipient: the highlighted match, a typed `kind:id`, or a problem. */
export function resolveMention(
  query: string,
  matches: readonly { address: string }[],
  highlighted: number
):
  | { kind: 'address'; address: string }
  | { kind: 'problem'; problem: ComposeProblem } {
  const picked = matches[highlighted] ?? matches[0];
  if (picked !== undefined) return { kind: 'address', address: picked.address };
  if (TYPED_ADDRESS.test(query)) return { kind: 'address', address: query };
  return {
    kind: 'problem',
    problem: {
      field: 'to',
      message: `No address matches @${query}. Pick one from the list, or type kind:id (task:t-1a2b3c, channel:general, human:ada).`,
    },
  };
}

/** Checks a draft before sending; the daemon still validates every address. */
export function composeProblem(state: ComposeState): ComposeProblem | null {
  const mention = trailingMention(state.body);
  if (mention !== null) {
    return {
      field: 'to',
      message: `Finish or remove @${mention.query} before sending.`,
    };
  }
  if (state.to.length === 0) {
    return { field: 'to', message: 'Add a recipient: type @ and pick one.' };
  }
  if (state.body.trim() === '') {
    return { field: 'body', message: 'Write a message first.' };
  }
  return null;
}

/** Wake defaults on when a task is a recipient, since a task may have no live run. */
export function wakeDefault(to: readonly string[]): boolean {
  return to.some((address) => address.startsWith('task:'));
}

/** The send body for a draft. A question blocks: it stays open until answered. */
export function toSendInput(state: ComposeState): SendInput {
  return {
    to: state.to,
    kind: state.kind,
    body: state.body.trim(),
    ...(state.urgent ? { urgent: true } : {}),
    ...(state.kind === 'question' ? { blocking: true } : {}),
    wake: state.wake ? 'request' : 'none',
  };
}

/** A failed send as an inline problem, with the daemon's field and text when it sent them. */
export function sendProblem(err: unknown): ComposeProblem {
  if (err instanceof ApiError) {
    return {
      field: err.field ?? (err.status === 409 ? 'replyTo' : 'send'),
      message: err.message,
    };
  }
  if (err instanceof Error) return { field: 'send', message: err.message };
  const message =
    typeof err === 'string' ? err : 'The message could not be sent.';
  return { field: 'send', message };
}

/** A daemon field in words: `to[0]` → Recipient 1. */
export function fieldLabel(field: string): string {
  const indexed = INDEXED_FIELD.exec(field);
  if (indexed !== null) {
    const noun = INDEXED_NOUNS[indexed[1] ?? ''] ?? indexed[1];
    return `${noun} ${Number(indexed[2]) + 1}`;
  }
  return FIELD_NAMES[field] ?? field;
}

export function problemText(problem: ComposeProblem): string {
  return `${fieldLabel(problem.field)}: ${problem.message}`;
}
