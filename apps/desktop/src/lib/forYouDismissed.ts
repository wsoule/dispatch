import type { Post } from './posts';

/**
 * "For you" posts you dismissed, per project: each post key maps to the
 * createdAt of the newest message it had when dismissed, so a later message on
 * the same subject brings the post back. Stored in localStorage because posts
 * are derived from the mailbox and never stored themselves.
 */
export type DismissedPosts = Readonly<Record<string, string>>;

const DAY_MS = 24 * 60 * 60 * 1000;

function key(root: string): string {
  return `dispatch:for-you-dismissed:${root}`;
}

export function readDismissedPosts(root: string | null): DismissedPosts {
  if (root === null || typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(key(root));
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (pair): pair is [string, string] => typeof pair[1] === 'string'
      )
    );
  } catch {
    return {};
  }
}

export function writeDismissedPosts(
  root: string | null,
  dismissed: DismissedPosts
): void {
  if (root === null || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key(root), JSON.stringify(dismissed));
  } catch {
    // Storage full or blocked: the post just comes back after a restart.
  }
}

/** Marks `posts` dismissed as of their newest message, dropping marks older
 *  than a day — buildPosts drops those posts anyway. */
export function dismissPosts(
  dismissed: DismissedPosts,
  posts: readonly Post[],
  now: number
): DismissedPosts {
  const next: Record<string, string> = {};
  for (const [k, at] of Object.entries(dismissed)) {
    if (now - Date.parse(at) <= DAY_MS) next[k] = at;
  }
  for (const post of posts) next[post.key] = post.latest.createdAt;
  return next;
}

/** The posts still showing: dismissed ones stay hidden until a newer message lands. */
export function visiblePosts(
  posts: readonly Post[],
  dismissed: DismissedPosts
): Post[] {
  return posts.filter((post) => {
    const at = dismissed[post.key];
    return at === undefined || post.latest.createdAt > at;
  });
}
