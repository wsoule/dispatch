// A daemon hosted for other people: app.dispatch.foo runs one per Linear
// workspace behind its planner. It answers only the routes the planning views
// use, whoever asks; everything else (runs, plans, the overseer, terminals,
// the browser, files, git, previews, A2A, federation, setup secrets, the
// Linear connection) is 404, even to the operator's own token. An allowlist,
// so a route added later is closed here until someone opens it on purpose.

/** `*` matches one path segment after `/api/`. HEAD is not GET here: a
 * method not listed is closed. */
const ALLOWED: ReadonlyArray<readonly [method: string, path: string]> = [
  // Who is asking, and sign-in.
  ['GET', 'whoami'],
  ['POST', 'session'],
  ['DELETE', 'session'],
  ['GET', 'people'],
  ['GET', 'setup'],
  ['GET', 'executors'],
  // Settings: only planning, statuses, labels and the Linear teams, at any
  // tier (hostedConfigProblem).
  ['GET', 'config'],
  ['PATCH', 'config'],
  ['GET', 'labels'],
  ['PUT', 'labels'],
  // Tasks, specs and comments.
  ['GET', 'tasks'],
  ['POST', 'tasks'],
  ['GET', 'tasks/ready'],
  ['GET', 'tasks/readiness'],
  ['GET', 'tasks/drafts'],
  ['GET', 'tasks/*'],
  ['PATCH', 'tasks/*'],
  ['POST', 'tasks/*/amend'],
  ['GET', 'tasks/*/comments'],
  ['POST', 'tasks/*/comments'],
  ['PATCH', 'tasks/*/comments/*'],
  ['DELETE', 'tasks/*/comments/*'],
  // Planning: allocation, digests, audit, milestone progress.
  ['GET', 'planning/allocation-runs'],
  ['POST', 'planning/allocation-runs'],
  ['GET', 'planning/allocation-runs/*'],
  ['GET', 'planning/audit'],
  ['GET', 'planning/digests'],
  ['GET', 'milestones/progress'],
  ['GET', 'milestones/*/progress'],
  // Linear: status, links and sync. The connection is the workspace install
  // the host stores; no route changes it.
  ['GET', 'linear/status'],
  ['GET', 'linear/links'],
  ['GET', 'linear/coverage'],
  ['GET', 'linear/teams'],
  ['GET', 'linear/states'],
  ['POST', 'linear/sync'],
  ['POST', 'linear/import'],
  // Members' tokens: the host's own credential only (hostedOwnerOnly).
  ['GET', 'team/tokens'],
  ['POST', 'team/tokens'],
  ['DELETE', 'team/tokens/*'],
  ['POST', 'team/tokens/*/linear'],
  ['DELETE', 'team/tokens/*/linear'],
  ['GET', 'team/status'],
  // What the app polls; empty or fixed on a planner-only daemon.
  ['GET', 'runs'],
  ['GET', 'presence'],
  ['POST', 'presence/focus'],
  ['GET', 'inbox'],
  ['GET', 'decisions'],
  ['GET', 'live-work'],
  ['GET', 'merge-queue'],
  ['GET', 'fix-loops'],
  ['GET', 'sync'],
];

const ROUTES = ALLOWED.map(([method, path]) => ({
  method,
  segments: path.split('/'),
}));

function matches(pattern: readonly string[], segments: readonly string[]) {
  return (
    pattern.length === segments.length &&
    pattern.every((s, i) => s === '*' || s === segments[i])
  );
}

/** Whether a hosted planner answers `method /api/<segments>`. */
export function hostedPlannerAllows(
  method: string,
  segments: readonly string[]
): boolean {
  return ROUTES.some(
    (route) => route.method === method && matches(route.segments, segments)
  );
}

/** Routes only the host's own credential (the app token) may use: members'
 * tokens are minted and revoked by the host alone, so a member can neither
 * make a token the host never issued nor revoke someone else's. */
export function hostedOwnerOnly(segments: readonly string[]): boolean {
  return segments[0] === 'team' && segments[1] === 'tokens';
}

/**
 * Fixed answers for routes whose real handlers run commands (`git`, `claude`,
 * `codex`, `xcode-select`): setup reports nothing to do, and sync reports
 * none, since a hosted planner has no checkout and runs no agent.
 */
export function hostedFixedAnswer(
  method: string,
  segments: readonly string[]
): unknown {
  if (method !== 'GET' || segments.length !== 1) return undefined;
  if (segments[0] === 'setup') return { steps: [], providers: [] };
  if (segments[0] === 'sync')
    return {
      state: 'disabled',
      detail: 'A hosted planner keeps no git checkout.',
      pendingOutgoing: 0,
      pendingIncoming: 0,
      lastSyncedAt: null,
      mergeDriverWarning: null,
      receipts: {
        state: 'disabled',
        detail: null,
        commit: null,
        changed: 0,
        removed: 0,
      },
    };
  return undefined;
}

// The config a hosted planner's people may change. Everything else (verify
// commands, executors, remotes, the notifications webhook, receipts and sync
// repos, the Linear app's OAuth settings) runs commands or sends data
// somewhere, so no tier sets it here.
const CONFIG_KEYS = new Set([
  'planning',
  'statuses',
  'statusRoles',
  'labels',
  'linear',
]);
const LINEAR_KEYS = new Set([
  'enabled',
  'teamId',
  'teamIds',
  'statusMap',
  'direction',
  'intervalSec',
  'includeAcceptanceCriteria',
  'archiveFinished',
]);

/** Why a hosted planner refuses this `PATCH /api/config` body, or null. */
export function hostedConfigProblem(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return null;
  for (const [key, value] of Object.entries(body)) {
    if (!CONFIG_KEYS.has(key))
      return `\`${key}\` cannot be set on a hosted planner.`;
    if (key === 'linear' && typeof value === 'object' && value !== null)
      for (const sub of Object.keys(value))
        if (!LINEAR_KEYS.has(sub))
          return `\`linear.${sub}\` cannot be set on a hosted planner.`;
  }
  return null;
}
