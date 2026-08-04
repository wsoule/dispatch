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
    githubId: raw.id as number,
    githubUpdatedAt: raw.updated_at as string,
    origin: 'github',
  };
}
