import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  type DeepLinkRouterDeps,
  useDeepLinkRouter,
} from './useDeepLinkRouter';

// Under happy-dom `useDeepLinks` takes the browser-harness branch, so a link
// is "received" by putting `?root=&task=` on the URL before the hook mounts
// (see useDeepLinks.test.ts for why `setURL` and not `replaceState`).
function setLink(root: string, task: string) {
  (
    window as unknown as { happyDOM: { setURL(url: string): void } }
  ).happyDOM.setURL(
    `http://localhost:5173/?root=${encodeURIComponent(root)}&task=${task}`
  );
}

// The hosted planner's form: `?issue=` alone, its root injected, not on the URL.
function setIssueLink(identifier: string) {
  (
    window as unknown as { happyDOM: { setURL(url: string): void } }
  ).happyDOM.setURL(`http://localhost:5173/?issue=${identifier}`);
}

afterEach(() => {
  (
    window as unknown as { happyDOM: { setURL(url: string): void } }
  ).happyDOM.setURL('http://localhost:5173/');
});

type Toast = Parameters<DeepLinkRouterDeps['notify']>[0];

interface Harness {
  deps: DeepLinkRouterDeps;
  opened: string[];
  toasts: Toast[];
  switched: string[];
  checked: string[];
}

function harness(
  overrides: Partial<DeepLinkRouterDeps> & {
    tasks?: string[];
    issues?: Record<string, string>;
  } = {}
): Harness {
  const opened: string[] = [];
  const toasts: Toast[] = [];
  const switched: string[] = [];
  const checked: string[] = [];
  const tasks = overrides.tasks ?? ['t-1a2b3c'];
  const issues = overrides.issues ?? { 'DIS-66': 't-1a2b3c' };
  const deps: DeepLinkRouterDeps = {
    activeProjectPath: '/repo/a',
    tasksReady: true,
    hasTask: (id) => tasks.includes(id),
    hasDispatch: (path) => {
      checked.push(path);
      return Promise.resolve(true);
    },
    switchProject: (path) => switched.push(path),
    openTask: (id) => opened.push(id),
    findIssueTask: (identifier) => Promise.resolve(issues[identifier] ?? null),
    openRun: () => Promise.resolve(false),
    notify: (toast) => toasts.push(toast),
    ...overrides,
  };
  return { deps, opened, toasts, switched, checked };
}

describe('useDeepLinkRouter', () => {
  test('a same-project link opens once tasks have loaded', async () => {
    setLink('/repo/a', 't-1a2b3c');
    // Cold start: the project is active before its daemon client exists, so
    // the task queries are disabled (not loading) and the lists are empty.
    const h = harness({ tasksReady: false, tasks: [] });
    const { rerender } = renderHook(
      (deps: DeepLinkRouterDeps) => useDeepLinkRouter(deps),
      { initialProps: h.deps }
    );
    await act(async () => {});
    expect(h.opened).toEqual([]);
    expect(h.toasts).toEqual([]);
    rerender({
      ...h.deps,
      tasksReady: true,
      hasTask: (id) => id === 't-1a2b3c',
    });
    await waitFor(() => expect(h.opened).toEqual(['t-1a2b3c']));
    expect(h.checked).toEqual([]);
    expect(h.switched).toEqual([]);
    expect(h.toasts).toEqual([]);
  });

  test('a link is consumed once: later loads do not reopen it', async () => {
    setLink('/repo/a', 't-1a2b3c');
    const h = harness();
    const { rerender } = renderHook(
      (deps: DeepLinkRouterDeps) => useDeepLinkRouter(deps),
      { initialProps: h.deps }
    );
    await waitFor(() => expect(h.opened).toEqual(['t-1a2b3c']));
    rerender({ ...h.deps, tasksReady: false });
    rerender({ ...h.deps, tasksReady: true });
    expect(h.opened).toEqual(['t-1a2b3c']);
  });

  test('another project is checked, switched to, and opened once active', async () => {
    setLink('/repo/b', 't-1a2b3c');
    const h = harness();
    const { rerender } = renderHook(
      (deps: DeepLinkRouterDeps) => useDeepLinkRouter(deps),
      { initialProps: h.deps }
    );
    await waitFor(() => expect(h.switched).toEqual(['/repo/b']));
    expect(h.checked).toEqual(['/repo/b']);
    expect(h.opened).toEqual([]);
    // The switch resets nav; the new project's tasks are not fetched yet (its
    // client is still resolving, so the queries are disabled and empty).
    rerender({
      ...h.deps,
      activeProjectPath: '/repo/b',
      tasksReady: false,
      hasTask: () => false,
    });
    await act(async () => {});
    expect(h.opened).toEqual([]);
    expect(h.toasts).toEqual([]);
    rerender({ ...h.deps, activeProjectPath: '/repo/b', tasksReady: true });
    await waitFor(() => expect(h.opened).toEqual(['t-1a2b3c']));
    expect(h.toasts).toEqual([]);
  });

  test('a project without .dispatch toasts Project not found', async () => {
    setLink('/repo/nowhere', 't-1a2b3c');
    const h = harness({ hasDispatch: () => Promise.resolve(false) });
    renderHook((deps: DeepLinkRouterDeps) => useDeepLinkRouter(deps), {
      initialProps: h.deps,
    });
    await waitFor(() => expect(h.toasts).toHaveLength(1));
    expect(h.toasts[0]).toEqual({
      title: 'Project not found',
      description: '/repo/nowhere',
      tone: 'error',
    });
    expect(h.switched).toEqual([]);
    expect(h.opened).toEqual([]);
  });

  test('a check that throws also reads as Project not found', async () => {
    setLink('/repo/b', 't-1a2b3c');
    const h = harness({ hasDispatch: () => Promise.reject(new Error('no')) });
    renderHook((deps: DeepLinkRouterDeps) => useDeepLinkRouter(deps), {
      initialProps: h.deps,
    });
    await waitFor(() => expect(h.toasts).toHaveLength(1));
    expect(h.toasts[0]?.title).toBe('Project not found');
  });

  test('an unknown id toasts Task not found', async () => {
    setLink('/repo/a', 't-ffffff');
    const h = harness();
    renderHook((deps: DeepLinkRouterDeps) => useDeepLinkRouter(deps), {
      initialProps: h.deps,
    });
    await waitFor(() => expect(h.toasts).toHaveLength(1));
    expect(h.toasts[0]).toEqual({
      title: 'Task not found',
      description: 't-ffffff',
      tone: 'error',
    });
    expect(h.opened).toEqual([]);
  });

  test('garbage toasts Bad link with the url', async () => {
    setLink('/repo/a', 'not-an-id');
    const h = harness();
    renderHook((deps: DeepLinkRouterDeps) => useDeepLinkRouter(deps), {
      initialProps: h.deps,
    });
    await act(async () => {});
    expect(h.toasts).toEqual([
      {
        title: 'Bad link',
        description: `dispatch://task/not-an-id?project=${encodeURIComponent('/repo/a')}`,
        tone: 'error',
      },
    ]);
    expect(h.checked).toEqual([]);
  });

  test('an issue link opens its task in the open project once tasks load', async () => {
    setIssueLink('DIS-66');
    const h = harness({ tasksReady: false });
    const { rerender } = renderHook(
      (deps: DeepLinkRouterDeps) => useDeepLinkRouter(deps),
      { initialProps: h.deps }
    );
    await act(async () => {});
    expect(h.opened).toEqual([]);
    rerender({ ...h.deps, tasksReady: true });
    await waitFor(() => expect(h.opened).toEqual(['t-1a2b3c']));
    expect(h.checked).toEqual([]);
    expect(h.switched).toEqual([]);
    expect(h.toasts).toEqual([]);
  });

  test('an issue no task links to toasts which identifier missed', async () => {
    setIssueLink('DIS-99');
    const h = harness();
    renderHook((deps: DeepLinkRouterDeps) => useDeepLinkRouter(deps), {
      initialProps: h.deps,
    });
    await waitFor(() => expect(h.toasts).toHaveLength(1));
    expect(h.toasts[0]).toEqual({
      title: 'No task for DIS-99',
      description: 'No task in this project is linked to DIS-99.',
      tone: 'error',
    });
    expect(h.opened).toEqual([]);
  });

  test('an issue link with no project open says so', async () => {
    setIssueLink('DIS-66');
    const h = harness({ activeProjectPath: null });
    renderHook((deps: DeepLinkRouterDeps) => useDeepLinkRouter(deps), {
      initialProps: h.deps,
    });
    await waitFor(() => expect(h.toasts).toHaveLength(1));
    expect(h.toasts[0]?.title).toBe('No project is open');
    expect(h.opened).toEqual([]);
  });

  test('a malformed issue identifier is a Bad link', async () => {
    setIssueLink('dis-66');
    const h = harness();
    renderHook((deps: DeepLinkRouterDeps) => useDeepLinkRouter(deps), {
      initialProps: h.deps,
    });
    await act(async () => {});
    expect(h.toasts).toEqual([
      {
        title: 'Bad link',
        description: 'dispatch://issue/dis-66',
        tone: 'error',
      },
    ]);
  });
});
