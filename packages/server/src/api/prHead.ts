import { PR_HEAD_REF_PREFIX } from '../orchestrator/pr.js';
import { errorResponse } from './http.js';

// Git resolves an unqualified `<name>` through `refs/<name>` before
// `refs/heads/<name>`, so `dispatch/pr/7` lands on the same ref as the fully
// qualified spelling and both have to be refused.
const PR_HEAD_REF_SPELLINGS: readonly string[] = [
  PR_HEAD_REF_PREFIX.toLowerCase(),
  PR_HEAD_REF_PREFIX.slice('refs/'.length).toLowerCase(),
];

/**
 * Whether `head` names a ref in the PR head namespace. That namespace is only
 * ever populated behind the fork confirmation gate, and the gated path calls
 * the runners directly rather than through any route — so nothing legitimate
 * arriving over HTTP needs it, while a caller naming one would cut a worktree
 * from a fork's code without passing the gate.
 *
 * Compared case-insensitively: a loose ref is a file, so on a case-insensitive
 * volume (macOS's default) `refs/Dispatch/pr/7` resolves to the same ref.
 */
function namesPrHeadRef(head: string): boolean {
  const ref = head.trim().toLowerCase();
  return PR_HEAD_REF_SPELLINGS.some((prefix) => ref.startsWith(prefix));
}

/**
 * The 400 for a route whose `head` becomes a worktree start point, or `null`
 * to proceed. Shared by every such route: review reads the fork's code and
 * verify additionally *runs* the project's recipe inside it, so both doors
 * onto the PR head namespace have to be shut, not just the one.
 */
export function refusePrHeadRef(head: string): Response | null {
  if (!namesPrHeadRef(head)) return null;
  return errorResponse(
    400,
    `invalid head: ${head} names a pull request head fetched behind the ` +
      'fork confirmation gate. Review a PR through ' +
      'POST /api/prs/:number/review-agent, which asks for that confirmation.'
  );
}
