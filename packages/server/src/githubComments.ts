import { randomBytes } from 'node:crypto';

import type { ReviewComment } from './reviewComments.js';

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(3).toString('hex')}`;
}

/**
 * Maps a GitHub review comment REST API payload to a local ReviewComment.
 *
 * Returns null when the payload has no usable path (cannot anchor the comment
 * to a file). Strips the diff prefix from the anchor line so it can match
 * real file content.
 */
export function mapGitHubComment(
  raw: Record<string, unknown>
): ReviewComment | null {
  // Reject payloads without a usable path.
  const path = raw.path;
  if (typeof path !== 'string' || path.trim() === '') {
    return null;
  }

  // Extract the file path.
  const file = path;

  // Determine the line number.
  const line = (raw.line ?? raw.original_line ?? 0) as number;

  // Extract and type startLine if present and differs from line.
  const startLine =
    typeof raw.start_line === 'number' && raw.start_line !== line
      ? raw.start_line
      : undefined;

  // Extract the anchor text from the last line of diff_hunk, stripping
  // the first character (the +/-/space diff marker).
  let anchorText = '';
  const side = raw.side as string | undefined;
  const subjectType = raw.subject_type as string | undefined;
  if (side !== 'LEFT' && subjectType !== 'file') {
    const diffHunk = raw.diff_hunk as string | undefined;
    if (typeof diffHunk === 'string') {
      const lines = diffHunk.split('\n');
      const lastLine = lines[lines.length - 1];
      if (typeof lastLine === 'string' && lastLine.length > 0) {
        // Strip the first character (diff marker).
        anchorText = lastLine.slice(1);
      }
    }
  }

  // Extract author, falling back to 'someone'.
  const user = raw.user as Record<string, unknown> | undefined;
  const author = typeof user?.login === 'string' ? user.login : 'someone';

  const body = typeof raw.body === 'string' ? raw.body : '';
  const created = typeof raw.created_at === 'string' ? raw.created_at : '';

  return {
    id: newId('rc'),
    file,
    line,
    ...(startLine !== undefined ? { startLine } : {}),
    anchorText,
    author,
    body,
    resolved: false,
    pending: false,
    created,
    replies: [],
    githubId: typeof raw.id === 'number' ? raw.id : undefined,
    githubUpdatedAt:
      typeof raw.updated_at === 'string' ? raw.updated_at : undefined,
    origin: 'github',
  };
}

/**
 * Merges what is stored locally with what a pull just returned into the
 * mirror's next state. Matches purely by `githubId` — body text and line
 * number can both legitimately change, so neither is an identity.
 */
export function mergeComments(
  local: ReviewComment[],
  remote: ReviewComment[]
): ReviewComment[] {
  const remoteById = new Map<number, ReviewComment>();
  for (const r of remote) {
    if (r.githubId !== undefined) remoteById.set(r.githubId, r);
  }

  const matched = new Set<number>();
  const merged: ReviewComment[] = [];

  for (const l of local) {
    if (l.githubId === undefined) {
      // No GitHub identity yet, so a pull cannot know about it: still
      // pending (not sent) or published but not pushed. Pass through.
      merged.push(l);
      continue;
    }
    const r = remoteById.get(l.githubId);
    if (r === undefined) {
      // Had an id, but the pull no longer returns it: deleted upstream.
      continue;
    }
    matched.add(l.githubId);
    // Last-writer-wins by comparing GitHub's reported update time against
    // what we last stored for it. `resolved` always stays local — GitHub
    // tracks resolution on the thread, not the comment (Task 5's job).
    const remoteIsNewer =
      r.githubUpdatedAt !== undefined &&
      l.githubUpdatedAt !== undefined &&
      r.githubUpdatedAt > l.githubUpdatedAt;
    merged.push({ ...(remoteIsNewer ? r : l), resolved: l.resolved });
  }

  for (const r of remote) {
    if (r.githubId !== undefined && !matched.has(r.githubId)) {
      merged.push(r);
    }
  }

  return merged;
}
