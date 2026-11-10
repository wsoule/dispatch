import { resolve } from 'node:path';

import { commandCwd, hintsAtHeldTarget } from './overseerHold.js';
import { isSimpleCommand, programName, shellWords } from './shellCommand.js';

/** How long "Allow for this conversation" lasts at most. */
export const GRANT_TTL_MS = 4 * 60 * 60 * 1000;

// Plain JSON with object keys sorted, so the same request always gives the same key.
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// A command line with runs of spaces and tabs outside quotes folded to one
// space and trimmed; quoted text, escapes and newlines stay as written.
function foldBlanks(command: string): string {
  let out = '';
  let blank = false;
  let i = 0;
  while (i < command.length) {
    const char = command[i];
    if (char === ' ' || char === '\t') {
      blank = true;
      i += 1;
      continue;
    }
    let end = i + 1;
    if (char === '\\') end = i + 2;
    else if (char === "'") {
      const close = command.indexOf("'", i + 1);
      end = close === -1 ? command.length : close + 1;
    } else if (char === '"' || (char === '$' && command[i + 1] === "'")) {
      // Double quotes and `$'…'` both honour backslash escapes.
      const quote = char === '"' ? '"' : "'";
      let j = char === '"' ? i + 1 : i + 2;
      while (j < command.length && command[j] !== quote) {
        j += command[j] === '\\' ? 2 : 1;
      }
      end = j + 1;
    }
    if (blank && out !== '') out += ' ';
    blank = false;
    out += command.slice(i, end);
    i = end;
  }
  return out;
}

// A tool name with no blanks, quotes or colons stands as its own key.
const PLAIN_TOOL_NAME = /^[\w.-]+$/;

/**
 * What a grant covers. A simple shell command (isSimpleCommand: one program,
 * plain arguments) grants its program, named as written when it is a path;
 * any other command line, or a simple one that hints at what a hold guards
 * (hintsAtHeldTarget, past `rootDir`), grants only that exact text, with runs
 * of blanks outside quotes folded. A command run anywhere but the checkout
 * root carries its directory in the key. A Codex permissions ask grants exactly
 * what it requested; any other tool's grant is the tool. Each free-text part is
 * JSON-quoted after a fixed kind word, so no two kinds of key can collide.
 */
export function grantKey(
  toolName: string,
  input: unknown,
  rootDir?: string
): string {
  if (toolName === 'codex.permissions') {
    const permissions =
      typeof input === 'object' && input !== null
        ? (input as { permissions?: unknown }).permissions
        : undefined;
    return `${toolName} ${stableJson(permissions ?? null)}`;
  }
  if (toolName !== 'Bash' && toolName !== 'codex.commandExecution') {
    return PLAIN_TOOL_NAME.test(toolName) ? toolName : JSON.stringify(toolName);
  }
  const command =
    typeof input === 'object' && input !== null
      ? (input as { command?: unknown }).command
      : undefined;
  if (typeof command !== 'string') return toolName;
  const rawCwd =
    typeof input === 'object' && input !== null
      ? (input as { cwd?: unknown }).cwd
      : undefined;
  const cwd =
    typeof rawCwd === 'string' && rawCwd !== ''
      ? commandCwd(input, rootDir ?? '/')
      : undefined;
  const first =
    isSimpleCommand(command) && !hintsAtHeldTarget(command, rootDir, cwd)
      ? shellWords(command)?.[0]
      : undefined;
  const key =
    first !== undefined
      ? `${toolName} program ${JSON.stringify(first.includes('/') ? first : programName(first))}`
      : `${toolName} command ${JSON.stringify(foldBlanks(command))}`;
  // A grant made in one directory never covers a command run in another.
  const elsewhere =
    cwd !== undefined && (rootDir === undefined || cwd !== resolve(rootDir));
  return elsewhere ? `${key} in ${JSON.stringify(cwd)}` : key;
}

/**
 * The grant key "Allow for this conversation" makes for an overseer action:
 * the tool itself, whatever its input. The kind word and the blank keep it
 * from ever matching a built-in tool's key (see grantKey).
 */
export function actionGrantKey(tool: string): string {
  return `overseer action ${tool}`;
}

interface Grant {
  grantedAt: number;
  expiresAt: number;
  /** The session it was granted in; a new session (a context rollover) ends it. */
  sessionId: string | undefined;
}

export interface GrantView {
  key: string;
  grantedAt: string;
  expiresAt: string;
}

/** Per-conversation grants that end at four hours or the next rollover, whichever is first. */
export class GrantStore {
  private readonly byConversation = new Map<string, Map<string, Grant>>();

  grant(
    conversationId: string,
    key: string,
    now: number,
    sessionId: string | undefined
  ): void {
    const grants = this.byConversation.get(conversationId) ?? new Map();
    grants.set(key, {
      grantedAt: now,
      expiresAt: now + GRANT_TTL_MS,
      sessionId,
    });
    this.byConversation.set(conversationId, grants);
  }

  allows(
    conversationId: string,
    key: string,
    now: number,
    sessionId: string | undefined
  ): boolean {
    const grants = this.byConversation.get(conversationId);
    const grant = grants?.get(key);
    if (grants === undefined || grant === undefined) return false;
    const rolledOver =
      grant.sessionId !== undefined && grant.sessionId !== sessionId;
    if (now >= grant.expiresAt || rolledOver) {
      grants.delete(key);
      return false;
    }
    return true;
  }

  list(conversationId: string, now: number): GrantView[] {
    const grants = this.byConversation.get(conversationId);
    if (grants === undefined) return [];
    const out: GrantView[] = [];
    for (const [key, grant] of grants) {
      if (now >= grant.expiresAt) {
        grants.delete(key);
        continue;
      }
      out.push({
        key,
        grantedAt: new Date(grant.grantedAt).toISOString(),
        expiresAt: new Date(grant.expiresAt).toISOString(),
      });
    }
    return out;
  }

  revoke(conversationId: string, key: string): boolean {
    return this.byConversation.get(conversationId)?.delete(key) ?? false;
  }

  clear(conversationId: string): void {
    this.byConversation.delete(conversationId);
  }
}
