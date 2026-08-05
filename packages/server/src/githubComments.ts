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
 *
 * Assumes `pending` and `githubId` are never both set on one local record:
 * the push path clears `pending` in the same step it assigns `githubId`.
 * A record that broke that invariant would be treated as published.
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
    // Last-writer-wins, but only on the fields GitHub actually owns: body,
    // its own update time, and where the comment now anchors. Written
    // field-by-field rather than by spread, so a future ReviewComment
    // field can't silently inherit the wrong side. id, replies and
    // resolved always stay local — GitHub has no concept of our local id,
    // never sees our reply threads, and tracks resolution on the thread
    // rather than the comment (Task 5's job).
    const remoteIsNewer =
      r.githubUpdatedAt !== undefined &&
      l.githubUpdatedAt !== undefined &&
      r.githubUpdatedAt > l.githubUpdatedAt;
    const winner = remoteIsNewer ? r : l;
    merged.push({
      id: l.id,
      file: l.file,
      line: winner.line,
      ...(winner.startLine !== undefined
        ? { startLine: winner.startLine }
        : {}),
      pending: l.pending,
      anchorText: winner.anchorText,
      author: l.author,
      body: winner.body,
      resolved: l.resolved,
      created: l.created,
      replies: l.replies,
      githubId: l.githubId,
      githubUpdatedAt: winner.githubUpdatedAt,
      origin: l.origin,
    });
  }

  for (const r of remote) {
    if (r.githubId !== undefined && !matched.has(r.githubId)) {
      merged.push(r);
    }
  }

  return merged;
}
