import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { reviewCommentsPath } from './orchestrator/paths.js';
import type { ReviewTarget } from './reviewTarget.js';

/**
 * Line-level review comments on a run's diff.
 *
 * The hard part is not storage, it is anchoring. A comment is written against a line, and then
 * the agent pushes more commits and that line moves, or stops existing. Three options were on
 * the table: silently keep the line number (so the comment ends up pointing at unrelated code),
 * re-anchor by searching for the text (guesswork that fails quietly), or record what the line
 * said and mark the comment outdated when it no longer matches.
 *
 * The third is implemented here. `anchorText` is the exact line content at the moment of
 * writing, so `resolveAnchor` can answer honestly: the line is where it was, the line moved to
 * a known place, or the code this was about is gone. A comment that has drifted is shown as
 * outdated rather than moved, because a wrong anchor presented confidently is worse than an
 * admitted stale one — the reader can still read the comment and decide.
 */

export interface ReviewComment {
  id: string;
  file: string;
  /** Line number in the new (post-change) side of the diff, at the time of writing. */
  line: number;
  /**
   * First line of a multi-line comment, when the reviewer selected a range. `line` is the last
   * line either way, matching how GitHub anchors a range comment to its end.
   */
  startLine?: number;
  /**
   * True while this comment belongs to a review the author has not submitted yet.
   *
   * This is what makes a review a review rather than a stream of interruptions: you read the
   * whole diff, leave notes as you go, and the agent hears about them once — with a verdict —
   * instead of being pinged per comment. Pending comments are visible to the author and are
   * excluded from anything that goes to the agent until submitted.
   */
  pending: boolean;
  /** What that line said when the comment was written — the anchor. */
  anchorText: string;
  author: string;
  body: string;
  resolved: boolean;
  created: string;
  /** Replies, oldest first. A thread is a comment plus these. */
  replies: ReviewReply[];
}

export interface ReviewReply {
  id: string;
  author: string;
  body: string;
  created: string;
}

export interface AddCommentInput {
  file: string;
  line: number;
  startLine?: number;
  anchorText: string;
  body: string;
  author?: string;
  /** Defaults to true: a comment written during a review is pending until the review is sent. */
  pending?: boolean;
}

/** How a submitted review lands. Mirrors the three things a reviewer can actually decide. */
export type ReviewVerdict = 'approve' | 'request-changes' | 'comment';

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(3).toString('hex')}`;
}

/** Where a comment's line ended up, once the file has changed underneath it. */
export type AnchorState =
  | { kind: 'exact'; line: number }
  | { kind: 'moved'; line: number }
  | { kind: 'outdated' };

/**
 * Finds where a comment's anchor line is now.
 *
 * Exact when the recorded line still says what it said. Moved when that text appears exactly
 * once elsewhere in the file — unambiguous, so following it is safe. Outdated in every other
 * case, including when the text appears several times: two candidate lines means we cannot know
 * which one was meant, and picking one would be a guess dressed as a fact.
 */
export function resolveAnchor(
  comment: Pick<ReviewComment, 'line' | 'anchorText'>,
  fileLines: string[]
): AnchorState {
  const idx = comment.line - 1;
  if (fileLines[idx] === comment.anchorText) {
    return { kind: 'exact', line: comment.line };
  }
  // An empty or whitespace-only anchor matches half the file; it can never be followed safely.
  if (comment.anchorText.trim() === '') return { kind: 'outdated' };

  const hits: number[] = [];
  for (let i = 0; i < fileLines.length; i++) {
    if (fileLines[i] === comment.anchorText) hits.push(i + 1);
    if (hits.length > 1) break;
  }
  if (hits.length === 1 && hits[0] !== undefined) {
    return { kind: 'moved', line: hits[0] };
  }
  return { kind: 'outdated' };
}

export class ReviewCommentStore {
  constructor(
    private readonly rootDir: string,
    // Serialized ActorRef credited when an add/reply supplies no author.
    private readonly defaultAuthor: string
  ) {}

  private file(target: ReviewTarget): string {
    return reviewCommentsPath(this.rootDir, target);
  }

  list(target: ReviewTarget): ReviewComment[] {
    const path = this.file(target);
    if (!existsSync(path)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      return Array.isArray(parsed) ? (parsed as ReviewComment[]) : [];
    } catch {
      // A corrupt file degrades to "no comments" rather than taking the daemon down, matching
      // how every other per-run artifact here behaves.
      return [];
    }
  }

  private write(target: ReviewTarget, comments: ReviewComment[]): void {
    const path = this.file(target);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(comments, null, 2)}\n`);
  }

  add(
    target: ReviewTarget,
    input: AddCommentInput,
    now = new Date().toISOString()
  ): ReviewComment {
    const comment: ReviewComment = {
      id: newId('rc'),
      file: input.file,
      line: input.line,
      ...(input.startLine !== undefined ? { startLine: input.startLine } : {}),
      anchorText: input.anchorText,
      author: input.author ?? this.defaultAuthor,
      body: input.body,
      resolved: false,
      pending: input.pending ?? true,
      created: now,
      replies: [],
    };
    const all = this.list(target);
    all.push(comment);
    this.write(target, all);
    return comment;
  }

  reply(
    target: ReviewTarget,
    commentId: string,
    body: string,
    author = this.defaultAuthor,
    now = new Date().toISOString()
  ): ReviewComment {
    const all = this.list(target);
    const comment = all.find((c) => c.id === commentId);
    if (comment === undefined) {
      throw new Error(`review comment not found: ${commentId}`);
    }
    comment.replies.push({ id: newId('rr'), author, body, created: now });
    this.write(target, all);
    return comment;
  }

  setResolved(
    target: ReviewTarget,
    commentId: string,
    resolved: boolean
  ): ReviewComment {
    const all = this.list(target);
    const comment = all.find((c) => c.id === commentId);
    if (comment === undefined) {
      throw new Error(`review comment not found: ${commentId}`);
    }
    comment.resolved = resolved;
    this.write(target, all);
    return comment;
  }

  remove(target: ReviewTarget, commentId: string): void {
    this.write(
      target,
      this.list(target).filter((c) => c.id !== commentId)
    );
  }

  /**
   * Publishes every pending comment on a target, returning how many were
   * released.
   *
   * Called when a review is submitted. Deliberately separate from acting on the verdict, and
   * done first: the comments become real, and only then does the caller resume or enqueue. If
   * the verdict action fails, the reviewer's writing still survives — the reverse order would
   * lose it.
   */
  publishPending(target: ReviewTarget): number {
    const all = this.list(target);
    let count = 0;
    for (const c of all) {
      if (!c.pending) continue;
      c.pending = false;
      count += 1;
    }
    if (count > 0) this.write(target, all);
    return count;
  }

  /** How many comments are staged but unsent — the number the review bar counts down. */
  pendingCount(target: ReviewTarget): number {
    return this.list(target).filter((c) => c.pending).length;
  }
}

/**
 * Renders the unresolved threads as the note that goes back to the agent.
 *
 * This is the contract the review UI's copy makes out loud — "the agent reads this when you send
 * the work back" — so it has to be real and it has to be specific enough to act on: file, line,
 * the code the comment was about, the comment, and any replies. Resolved threads are left out,
 * because resolving one is exactly how you say "never mind".
 */
export function formatCommentsForAgent(comments: ReviewComment[]): string {
  // Resolved threads are settled, and pending ones have not been sent yet — neither belongs in
  // what the agent is asked to act on.
  const open = comments.filter((c) => !c.resolved && !c.pending);
  if (open.length === 0) return '';

  const byFile = new Map<string, ReviewComment[]>();
  for (const c of open) {
    const bucket = byFile.get(c.file);
    if (bucket === undefined) byFile.set(c.file, [c]);
    else bucket.push(c);
  }

  const sections: string[] = [
    'Review comments on your changes. Each one names the file, the line it was written ' +
      'against, and the code at that line. Address every one of them.',
  ];
  for (const [file, list] of byFile) {
    const lines = [`### ${file}`];
    for (const c of [...list].sort((a, b) => a.line - b.line)) {
      lines.push('');
      lines.push(
        c.startLine !== undefined && c.startLine !== c.line
          ? `Lines ${c.startLine}-${c.line}:`
          : `Line ${c.line}:`
      );
      if (c.anchorText.trim() !== '') {
        lines.push('```');
        lines.push(c.anchorText);
        lines.push('```');
      }
      lines.push(`${c.author}: ${c.body}`);
      for (const r of c.replies) lines.push(`${r.author}: ${r.body}`);
    }
    sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}
