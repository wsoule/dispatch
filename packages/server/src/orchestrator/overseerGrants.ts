/** How long "Allow for this conversation" lasts at most. */
export const GRANT_TTL_MS = 4 * 60 * 60 * 1000;

// The program a shell command runs, past env assignments and a path.
function programOf(command: string): string | null {
  const words = command.trim().split(/\s+/);
  const first = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  if (first === undefined || first === '') return null;
  return first.slice(first.lastIndexOf('/') + 1);
}

/** What a grant covers: a Bash grant is one program's (`Bash:moonx`), any other tool's is the tool. */
export function grantKey(toolName: string, input: unknown): string {
  if (toolName !== 'Bash') return toolName;
  const command =
    typeof input === 'object' && input !== null
      ? (input as { command?: unknown }).command
      : undefined;
  const program = typeof command === 'string' ? programOf(command) : null;
  return program === null ? toolName : `${toolName}:${program}`;
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
