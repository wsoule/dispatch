import { useEffect, useRef, useState } from 'react';

import type { NavAction, NavState } from '../lib/appNav';
import { hrefForState, parseHref } from '../lib/routes';

/** What the hash route needs from App: the nav state and its dispatch. */
export interface HashRouteDeps {
  state: NavState;
  dispatch: (action: NavAction) => void;
}

/** The hash a window opened on, or null when it carries none. */
function initialHash(): string | null {
  const hash = window.location.hash;
  return hash === '' ? null : hash;
}

/**
 * Keeps `location.hash` and the nav state in step, both ways. Mounted once in
 * App. The hash is the top place only (lib/routes.ts): a reload on the
 * Overseer, or with Settings open, comes back there with Tasks on its list,
 * not on the page the reducer had left it on.
 *
 * Out: every state change is written to the hash with `history.replaceState`,
 * never `pushState` — the reducer owns history (the back and forward keys walk
 * its entries), so the browser's own history never grows. The search part of
 * the URL (the daemon's `?root=&port=&token=`) is left exactly as it is.
 *
 * In: a `hashchange` the hook did not cause (a modified or middle click on a
 * link that the browser followed in this window, a hash typed into the bar) is
 * parsed and its actions dispatched. The href just written is remembered and
 * skipped, so mirroring never dispatches and dispatching never writes twice.
 *
 * On first mount with a hash, the route is applied once a project is active:
 * `selectProject` resets the nav state, so applying it earlier would lose the
 * place. The mirror waits for that too, or it would overwrite the hash with
 * the initial state's before the route was read. A project switch rewrites the
 * hash from the reset state like any other change.
 *
 * `#/task/<id>` needs no hold on the tasks loading: the task page shows a
 * loading state until the project's tasks are fetched (TaskPageView), and only
 * then "no longer available".
 */
export function useHashRoute({ state, dispatch }: HashRouteDeps): void {
  const [pending, setPending] = useState<string | null>(initialHash);
  const lastWritten = useRef<string | null>(null);
  // The hash last applied as a route: StrictMode replays the effect below with
  // the same `pending`, and a route is applied once.
  const applied = useRef<string | null>(null);
  // App's dispatch is stable, but the state is read inside the listener, so
  // both come through refs and the subscription happens once.
  const stateRef = useRef(state);
  stateRef.current = state;
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  const { activeProjectId } = state;
  useEffect(() => {
    if (pending === null || activeProjectId === null) return;
    setPending(null);
    if (applied.current === pending) return;
    applied.current = pending;
    const actions = parseHref(pending);
    if (actions === null) return;
    lastWritten.current = pending;
    for (const action of actions) dispatchRef.current(action);
  }, [pending, activeProjectId]);

  useEffect(() => {
    if (pending !== null) return;
    const href = hrefForState(state);
    if (href === lastWritten.current) return;
    lastWritten.current = href;
    if (window.location.hash === href) return;
    const { pathname, search } = window.location;
    window.history.replaceState(
      window.history.state,
      '',
      `${pathname}${search}${href}`
    );
  }, [state, pending]);

  useEffect(() => {
    function onHashChange() {
      const hash = window.location.hash;
      if (hash === lastWritten.current) return;
      if (stateRef.current.activeProjectId === null) {
        // No project yet: hold it the way the opening hash is held.
        applied.current = null;
        setPending(hash === '' ? null : hash);
        return;
      }
      const actions = parseHref(hash);
      if (actions === null) return;
      lastWritten.current = hash;
      for (const action of actions) dispatchRef.current(action);
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
}
