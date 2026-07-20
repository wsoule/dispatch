export type ProjectTab = 'overview' | 'board' | 'sessions' | 'tasks';

/** Decides which tab `ProjectDetail` should actually render given the tab requested (either
 * the user clicking a tab button, or `TasksView` opening a project straight to
 * `initialTab="tasks"`) and whether the project has turned out to be dispatch-enabled. Falls
 * back to `'overview'` once `dispatchEnabled` resolves to `false` while the requested tab is
 * `'tasks'` — the Tasks tab button disappears from the tab bar in that case and there is no
 * Tasks content to show, so staying on `'tasks'` would leave the content area blank forever.
 * Pure and separate from the `has_dispatch` query itself so this fallback decision is
 * unit-testable without mounting `ProjectDetail`.
 *
 * While `dispatchEnabled` is still `undefined` (the query hasn't resolved yet), the requested
 * tab is left alone rather than bounced to `'overview'` — `ProjectDetail` shows a brief loading
 * state for that window instead, so a fast resolve straight to `true` doesn't flash the
 * Overview tab first. */
export function resolveActiveTab(
  requestedTab: ProjectTab,
  dispatchEnabled: boolean | undefined
): ProjectTab {
  if (requestedTab === 'tasks' && dispatchEnabled === false) return 'overview';
  return requestedTab;
}
