import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { useReducer } from 'react';

import { initialNavState, navReducer, type NavState } from '../lib/appNav';
import { useHashRoute } from './useHashRoute';

// The hook over a real reducer under happy-dom. The registrator's document
// starts at `about:blank`, where `replaceState` refuses a URL, so happy-dom's
// own `setURL` gives it an origin, with the daemon's search part the hook must
// leave alone.
const SEARCH = '?root=repo-a&port=4100&token=secret';

function setUrl(hash: string) {
  (
    window as unknown as { happyDOM: { setURL(url: string): void } }
  ).happyDOM.setURL(`http://localhost:5173/${SEARCH}${hash}`);
}

afterEach(() => {
  setUrl('');
});

/** App's side: the nav reducer with the hook mounted over it. */
function mount(from: NavState = initialNavState) {
  return renderHook(() => {
    const [state, dispatch] = useReducer(navReducer, from);
    useHashRoute({ state, dispatch });
    return { state, dispatch };
  });
}

const WITH_PROJECT: NavState = navReducer(initialNavState, {
  type: 'selectProject',
  projectId: '/repo/a',
});

describe('useHashRoute', () => {
  test('mirrors the place into the hash with replaceState and keeps the search', () => {
    setUrl('');
    const pushState = mock(() => {});
    const realPush = window.history.pushState.bind(window.history);
    window.history.pushState = pushState as typeof window.history.pushState;
    try {
      const { result } = mount(WITH_PROJECT);
      expect(window.location.hash).toBe('#/overseer');
      act(() =>
        result.current.dispatch({ type: 'showTasks', preset: 'failed' })
      );
      expect(window.location.hash).toBe('#/issues?preset=failed');
      act(() =>
        result.current.dispatch({
          type: 'openTask',
          taskId: 't-1',
          tab: 'review',
          runId: 'r-2',
        })
      );
      expect(window.location.hash).toBe('#/task/t-1?tab=review&run=r-2');
      expect(window.location.search).toBe(SEARCH);
      // A drawer is not a place: the hash does not move for a peek.
      act(() => result.current.dispatch({ type: 'openPeek', taskId: 't-9' }));
      expect(window.location.hash).toBe('#/task/t-1?tab=review&run=r-2');
      expect(pushState).not.toHaveBeenCalled();
    } finally {
      window.history.pushState = realPush;
    }
  });

  test('the hash the window opened on is applied once a project is active', () => {
    setUrl('#/timeline?project=p-1');
    const { result } = mount();
    // No project yet: the route waits, and the hash is not overwritten.
    expect(result.current.state.tasksPage).toEqual({ kind: 'list' });
    expect(window.location.hash).toBe('#/timeline?project=p-1');
    act(() =>
      result.current.dispatch({ type: 'selectProject', projectId: '/repo/a' })
    );
    expect(result.current.state.mainView).toBe('tasks');
    expect(result.current.state.tasksPage).toEqual({
      kind: 'view',
      view: 'timeline',
      project: 'p-1',
    });
    expect(window.location.hash).toBe('#/timeline?project=p-1');
    // Applied once: the project's history holds the list and the Timeline.
    expect(result.current.state.history).toHaveLength(2);
  });

  test('an opening hash that is not a route is replaced by the place', () => {
    setUrl('#main');
    const { result } = mount(WITH_PROJECT);
    expect(result.current.state).toEqual(WITH_PROJECT);
    expect(window.location.hash).toBe('#/overseer');
  });

  // happy-dom reports a hash assignment on a later tick (and more than once),
  // so the state is awaited.
  test('a hashchange the hook did not write is applied, once', async () => {
    setUrl('');
    const { result } = mount(WITH_PROJECT);
    act(() => {
      window.location.hash = '#/graph?project=p-1';
    });
    await waitFor(() =>
      expect(result.current.state.tasksPage).toEqual({
        kind: 'view',
        view: 'graph',
        scope: { level: 'issue', projectId: 'p-1' },
        nodeId: null,
      })
    );
    // One place entered, however many times the browser reports the change.
    expect(result.current.state.history).toHaveLength(2);
    expect(window.location.hash).toBe('#/graph?project=p-1');
    // A hash that is not a route changes nothing.
    act(() => {
      window.location.hash = '#/nowhere';
    });
    await waitFor(() => expect(window.location.hash).toBe('#/nowhere'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(result.current.state.history).toHaveLength(2);
  });

  test('a hash the hook wrote is not dispatched back', () => {
    setUrl('');
    const { result } = mount(WITH_PROJECT);
    act(() => result.current.dispatch({ type: 'showTasks' }));
    const after = result.current.state;
    // The browser reporting the hook's own write is a no-op.
    act(() => {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(result.current.state).toBe(after);
  });

  test('a project switch rewrites the hash from the reset state', () => {
    setUrl('');
    const { result } = mount(WITH_PROJECT);
    act(() => result.current.dispatch({ type: 'openTask', taskId: 't-1' }));
    expect(window.location.hash).toBe('#/task/t-1');
    act(() =>
      result.current.dispatch({ type: 'selectProject', projectId: '/repo/b' })
    );
    // The view stays (Tasks), the page does not.
    expect(window.location.hash).toBe('#/issues');
  });

  test('a hashchange before any project is active is held like the opening hash', async () => {
    setUrl('');
    const { result } = mount();
    act(() => {
      window.location.hash = '#/docs/spec';
    });
    await waitFor(() => expect(window.location.hash).toBe('#/docs/spec'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(result.current.state.tasksPage).toEqual({ kind: 'list' });
    act(() =>
      result.current.dispatch({ type: 'selectProject', projectId: '/repo/a' })
    );
    expect(result.current.state.tasksPage).toEqual({
      kind: 'docs',
      docId: 'spec',
      anchor: null,
      merge: null,
    });
    expect(window.location.hash).toBe('#/docs/spec');
  });
});
