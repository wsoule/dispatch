// A daemon hosted for other people: app.dispatch.foo runs one per Linear
// workspace behind its planner. It answers only the routes the planning views
// use, whoever asks; everything else (runs, plans, the overseer, terminals,
// the browser, files, git, previews, A2A, federation, setup secrets) is 404,
// even to the operator's own token. An allowlist, so a route added later is
// closed here until someone opens it on purpose.

/** `*` matches one path segment after `/api/`. */
const ALLOWED: ReadonlyArray<readonly [method: string, path: string]> = [
  // Who is asking, and sign-in.
  ['GET', 'whoami'],
  ['POST', 'session'],
  ['DELETE', 'session'],
  ['GET', 'people'],
  ['GET', 'setup'],
  ['GET', 'executors'],
  // Settings: the planning block, statuses, labels. Operator-only keys stay
  // operator-only through the usual tiers.
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
  // Linear: status, links, sync, and the host's connection.
  ['GET', 'linear/status'],
  ['GET', 'linear/links'],
  ['GET', 'linear/coverage'],
  ['GET', 'linear/teams'],
  ['GET', 'linear/states'],
  ['POST', 'linear/sync'],
  ['POST', 'linear/import'],
  ['POST', 'linear/connect'],
  ['POST', 'linear/disconnect'],
  // The host mints each member's token.
  ['GET', 'team/tokens'],
  ['POST', 'team/tokens'],
  ['DELETE', 'team/tokens/*'],
  ['GET', 'team/status'],
  // What the app polls; empty on a planner-only daemon.
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

/** Whether a hosted planner answers `method /api/<segments>`. */
export function hostedPlannerAllows(
  method: string,
  segments: readonly string[]
): boolean {
  const verb = method === 'HEAD' ? 'GET' : method;
  return ROUTES.some(
    (route) =>
      route.method === verb &&
      route.segments.length === segments.length &&
      route.segments.every((s, i) => s === '*' || s === segments[i])
  );
}
