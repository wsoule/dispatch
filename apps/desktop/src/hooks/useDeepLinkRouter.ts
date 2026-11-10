import { useCallback, useEffect, useRef, useState } from 'react';

import { type DeepLink, parseDeepLink } from '../lib/deepLink';
import { useDeepLinks } from './useDeepLinks';

/** Everything the router needs from App, injected so it runs under happy-dom. */
export interface DeepLinkRouterDeps {
  activeProjectPath: string | null;
  /**
   * True only once the active project's task lists — plain and archived-
   * inclusive — have been fetched. Readiness, not an in-flight flag: React
   * Query's `isLoading` is false for a query that is merely disabled (no
   * daemon client yet), which is every cold start and project switch.
   */
  tasksReady: boolean;
  /** Whether the active project's tasks hold `id`. Consulted only once
   * `tasksReady` is true, and must see the archived list too. */
  hasTask(id: string): boolean;
  /** Whether `path` is a dispatch-enabled project (`lib/tauri.ts`'s `hasDispatch`). */
  hasDispatch(path: string): Promise<boolean>;
  /** App's `selectSwitchProject` — resets nav, so the task opens afterwards. */
  switchProject(path: string): void;
  openTask(id: string): void;
  /** The id of the active project's task linked to the Linear issue
   * `identifier` (`lib/deepLink.ts`'s `resolveIssueTask`), or null. Consulted
   * only once `tasksReady` is true. */
  findIssueTask(identifier: string): Promise<string | null>;
  /** Opens the run's task on that run; false when the project has no such run. */
  openRun(runId: string): Promise<boolean>;
  notify(toast: {
    title: string;
    description?: string;
    tone: 'error' | 'info';
  }): void;
}

/**
 * Turns a received deep link into "switch project if needed, then open it".
 * A task or run link for another project is held as `pending` across the
 * switch and lands once `activeProjectPath` matches and that project's tasks
 * have loaded — waiting on `tasksReady` is what keeps a cold-start link from
 * landing on the task view's "no longer available" state. An issue link names
 * no project (task ids differ per project; the Linear identifier is the shared
 * key), so it resolves in whichever project is open. Every failure is a toast:
 * a link that does not parse, a project without `.dispatch/`, no project open,
 * or nothing in the project to open.
 */
export function useDeepLinkRouter(deps: DeepLinkRouterDeps): void {
  const [pending, setPending] = useState<DeepLink | null>(null);
  // The deps object is rebuilt every App render; the handlers read the latest
  // through a ref so neither the link subscription nor the effect re-arms.
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const handleLink = useCallback((url: string) => {
    const link = parseDeepLink(url);
    const current = depsRef.current;
    if (link === null) {
      current.notify({ title: 'Bad link', description: url, tone: 'error' });
      return;
    }
    if (link.kind === 'issue') {
      if (current.activeProjectPath === null) {
        current.notify({
          title: 'No project is open',
          description: `Open the project that ${link.identifier} belongs to, then open the link again.`,
          tone: 'error',
        });
        return;
      }
      setPending(link);
      return;
    }
    if (link.project === current.activeProjectPath) {
      setPending(link);
      return;
    }
    // A check that throws (no backend, unreadable path) reads as not found.
    void current
      .hasDispatch(link.project)
      .catch(() => false)
      .then((enabled) => {
        if (!enabled) {
          depsRef.current.notify({
            title: 'Project not found',
            description: link.project,
            tone: 'error',
          });
          return;
        }
        depsRef.current.switchProject(link.project);
        setPending(link);
      });
  }, []);

  useDeepLinks(handleLink);

  const { activeProjectPath, tasksReady } = deps;
  useEffect(() => {
    if (pending === null || activeProjectPath === null || !tasksReady) return;
    if (pending.kind !== 'issue' && activeProjectPath !== pending.project) {
      return;
    }
    setPending(null);
    const current = depsRef.current;
    const notFound = (title: string, description: string) =>
      depsRef.current.notify({ title, description, tone: 'error' });
    switch (pending.kind) {
      case 'task':
        if (current.hasTask(pending.taskId)) current.openTask(pending.taskId);
        else notFound('Task not found', pending.taskId);
        return;
      case 'run':
        void current
          .openRun(pending.runId)
          .catch(() => false)
          .then((opened) => {
            if (!opened) notFound('Run not found', pending.runId);
          });
        return;
      case 'issue':
        void current
          .findIssueTask(pending.identifier)
          .catch(() => null)
          .then((taskId) => {
            if (taskId !== null) depsRef.current.openTask(taskId);
            else {
              notFound(
                `No task for ${pending.identifier}`,
                `No task in this project is linked to ${pending.identifier}.`
              );
            }
          });
        return;
    }
  }, [pending, activeProjectPath, tasksReady]);
}
