// How the desktop's wall-clock perf tests size their budgets.

/** How much slower the same work measured in CI than on a developer machine. */
const CI_FACTOR = 3;

/**
 * A perf test's budget in ms: the written budget locally, three times that in
 * CI (process.env.CI, which GitHub Actions sets). `moon ci` runs this suite
 * beside the server's 13-minute suite and every other package's tasks on a
 * shared 4-core runner, where the same render measured about 4x the local
 * time (ProjectsView's 300 projects after a warm-up mount: 260-320 ms here,
 * 1,178 ms there; the graph page: about 1,100-1,370 ms against a 1,500 ms
 * budget). Three times keeps an order-of-magnitude regression failing in CI
 * while contention alone does not; the written budget stays the promise a
 * developer's run checks.
 */
export function perfBudgetMs(writtenMs: number): number {
  return process.env.CI ? writtenMs * CI_FACTOR : writtenMs;
}
