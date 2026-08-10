import type { ApiContext } from '../api.js';
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
 * arriving over HTTP needs it.
 *
 * Compared case-insensitively: a loose ref is a file, so on a case-insensitive
 * volume (macOS's default) `refs/Dispatch/pr/7` resolves to the same ref.
 */
function namesPrHeadRef(head: string): boolean {
  const ref = head.trim().toLowerCase();
  return PR_HEAD_REF_SPELLINGS.some((prefix) => ref.startsWith(prefix));
}

/**
 * Whether the only thing vouching for `head` is a fetched pull request head.
 *
 * The name rule above is a spelling rule, and a commit has more than one
 * spelling: `GET /api/prs` hands every caller a `headRefOid`, which reaches
 * the same tree as the ref without ever matching the prefix. This asks git
 * what the commit is reachable from instead, so both spellings answer alike.
 *
 * An unresolvable `head` is not this function's to refuse — it returns false
 * and lets the dispatch below report the bad revision in its own words.
 */
function onlyPrHeadReaches(head: string, ctx: ApiContext): boolean {
  const refs = ctx.orchestrator.refsContaining(head);
  if (refs === null) return false;
  // No ref at all reaches it: a dangling object, which is what a fetched PR
  // head becomes once its ref is deleted on retirement. Nothing a caller
  // should be naming, and the one shape that outlives the name rule.
  if (refs.length === 0) return true;
  return refs.every((ref) =>
    ref.toLowerCase().startsWith(PR_HEAD_REF_PREFIX.toLowerCase())
  );
}

/**
 * The 400 for a route whose `head` becomes a worktree start point, or `null`
 * to proceed. Shared by every such route: review reads a fork's code and
 * verify additionally *runs* the project's recipe inside it, so both doors
 * onto the PR head namespace have to be shut, not just the one.
 */
export function refusePrHeadRef(
  head: string,
  ctx: ApiContext
): Response | null {
  if (!namesPrHeadRef(head) && !onlyPrHeadReaches(head, ctx)) return null;
  return errorResponse(
    400,
    `invalid head: ${head} resolves to a pull request head fetched behind ` +
      'the fork confirmation gate, and nothing else in this repository ' +
      'reaches it. Review a PR through POST /api/prs/:number/review-agent, ' +
      'which asks for that confirmation.'
  );
}
