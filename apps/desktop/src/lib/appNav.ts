// The whole app's navigation state, modeled as one pure reducer so routing decisions (what
// the sidebar highlights, what the main pane renders, whether the task peek/run
// split/command palette are open) are unit-testable without mounting React. App.tsx is the
// only place that owns a `useReducer(navReducer, initialNavState)` — every view/shell
// component below it receives plain props derived from this state plus dispatch callbacks,
// the same "dumb view, smart root" split TasksPanel used for the old dispatch-only pane.

/** The primary views for whichever project is active. `new-task` never renders
 * — App.tsx reads it as "open the AI composer" and hands the old view back. */
export type ProjectView =
  | 'overview'
  | 'board'
  | 'runs'
  | 'branches'
  | 'pull-requests'
  | 'review'
  | 'brain-dump'
  | 'plans'
  | 'new-task';

/** Global, not-project-scoped views living below the primary nav in the sidebar. */
export type GlobalView = 'all-agents' | 'sessions' | 'settings';

export interface NavState {
  /** Which side of the sidebar's split is active — a project's own work, or one of the
   * global views. Kept separate from `activeProjectId` so switching to a global view
   * doesn't lose track of which project to snap back to. */
  section: 'project' | 'global';
  /** The last project selected via the project switcher, or `null` before any project has
   * ever resolved as dispatch-enabled (the get-started/first-run state). */
  activeProjectId: string | null;
  projectView: ProjectView;
  globalView: GlobalView;
  /** Task id shown in the side peek panel, or `null` when it's closed. */
  peekTaskId: string | null;
  /** Run id shown in the Runs view's right pane, or `null` when nothing is selected. */
  activeRunId: string | null;
  /** Which view to snap `projectView` back to once the AI composer dialog opens — a board
   * column's "+" returns to the board, rather than one fixed view. */
  newTaskReturnView: ProjectView;
  paletteOpen: boolean;
  /**
   * Where you have been, newest last, and how far back you have stepped.
   *
   * Without this every "back" affordance had to name one fixed destination, so
   * closing a review always went to the same place regardless of where you
   * opened it from — which is only right for whoever happened to arrive that
   * way. An index rather than popping, so forward still works after going back.
   */
  history: NavEntry[];
  historyIndex: number;
}

/** One visited destination. Runs and Review key off a run id, so it travels
 * with the entry — going back to a review you had open should reopen it. */
export interface NavEntry {
  section: 'project' | 'global';
  projectView: ProjectView;
  globalView: GlobalView;
  activeRunId: string | null;
}

export const initialNavState: NavState = {
  section: 'project',
  activeProjectId: null,
  projectView: 'overview',
  globalView: 'sessions',
  peekTaskId: null,
  activeRunId: null,
  newTaskReturnView: 'board',
  paletteOpen: false,
  history: [
    {
      section: 'project',
      projectView: 'overview',
      globalView: 'sessions',
      activeRunId: null,
    },
  ],
  historyIndex: 0,
};

/** Truncates any forward entries and appends — the browser rule: navigating
 * somewhere new after going back discards what you had gone back from. */
function pushHistory(state: NavState, next: NavEntry): NavState {
  const kept = state.history.slice(0, state.historyIndex + 1);
  const last = kept[kept.length - 1];
  // Re-selecting the view you are already on is not a new destination.
  if (
    last !== undefined &&
    last.section === next.section &&
    last.projectView === next.projectView &&
    last.globalView === next.globalView &&
    last.activeRunId === next.activeRunId
  ) {
    return state;
  }
  const history = [...kept, next].slice(-50);
  return { ...state, history, historyIndex: history.length - 1 };
}

export type NavAction =
  | { type: 'selectProject'; projectId: string }
  | { type: 'setProjectView'; view: ProjectView }
  | { type: 'setGlobalView'; view: GlobalView }
  | { type: 'openPeek'; taskId: string }
  | { type: 'closePeek' }
  | { type: 'openRun'; runId: string }
  | { type: 'closeRun' }
  /** Routes to `new-task`, remembering the view to come back to — App.tsx reads reaching this
   * state as "open the AI composer dialog". */
  | { type: 'openNewTask' }
  | { type: 'closeNewTask' }
  | { type: 'openPalette' }
  | { type: 'closePalette' }
  | { type: 'togglePalette' }
  | { type: 'back' }
  | { type: 'forward' }
  /** Context-sensitive close: the command palette wins over the task peek, and each one open
   * swallows the Escape rather than also clearing the next layer. */
  | { type: 'escape' };

export function navReducer(state: NavState, action: NavAction): NavState {
  switch (action.type) {
    case 'selectProject':
      // Switching projects always lands on Board (the "heart of the app") and drops any
      // peek/run selection scoped to the previous project rather than carrying over an id
      // that belongs to a different project's task/run list.
      return {
        ...state,
        section: 'project',
        activeProjectId: action.projectId,
        projectView: 'overview',
        peekTaskId: null,
        activeRunId: null,
      };
    case 'setProjectView': {
      const activeRunId =
        // Runs and Pull requests both key their selection off `activeRunId` (a PR is just a
        // run with an open PR), so keep it when moving between those two; any other view
        // clears it so re-entering starts fresh rather than reopening a stale selection.
        action.view === 'runs' ||
        action.view === 'pull-requests' ||
        // Review is a full-page view OF the selected run, so moving into it must keep the
        // selection rather than clearing it and landing on an empty surface.
        action.view === 'review'
          ? state.activeRunId
          : null;
      const next: NavState = {
        ...state,
        section: 'project',
        projectView: action.view,
        activeRunId,
      };
      return pushHistory(next, {
        section: 'project',
        projectView: action.view,
        globalView: state.globalView,
        activeRunId,
      });
    }
    case 'setGlobalView':
      // A global view (Settings, Sessions, All Agents) isn't showing any project's task
      // list at all, so a task peek left open from whatever project view preceded it has
      // nothing left to sit "over" — drop it rather than let it render on top of an
      // unrelated global screen.
      return {
        ...state,
        section: 'global',
        globalView: action.view,
        peekTaskId: null,
      };
    case 'openPeek':
      return { ...state, peekTaskId: action.taskId };
    case 'closePeek':
      return { ...state, peekTaskId: null };
    case 'openRun':
      // Opening a different run is a destination in its own right, so back
      // returns to the one you were looking at rather than skipping the view.
      return pushHistory(
        { ...state, activeRunId: action.runId },
        {
          section: state.section,
          projectView: state.projectView,
          globalView: state.globalView,
          activeRunId: action.runId,
        }
      );
    case 'closeRun':
      return { ...state, activeRunId: null };
    case 'back':
    case 'forward': {
      const delta = action.type === 'back' ? -1 : 1;
      const index = state.historyIndex + delta;
      const entry = state.history[index];
      if (entry === undefined) return state;
      return {
        ...state,
        historyIndex: index,
        section: entry.section,
        projectView: entry.projectView,
        globalView: entry.globalView,
        activeRunId: entry.activeRunId,
        // Moving through history is navigation, not a modal action — anything
        // layered on top closes rather than following you to the new screen.
        peekTaskId: null,
        paletteOpen: false,
      };
    }
    case 'openNewTask':
      // The creator is a project-section destination, so opening it from a global view
      // (Settings/Sessions/All Agents) also moves back into the project section and returns to
      // that project's last view on close — `projectView` still holds it, since `setGlobalView`
      // never overwrites it. `new-task` itself is never recorded as the return target, so a
      // second "New task" while it's already open can't turn Escape into a no-op that just
      // reopens the same page.
      return {
        ...state,
        section: 'project',
        projectView: 'new-task',
        activeRunId: null,
        newTaskReturnView:
          state.projectView !== 'new-task'
            ? state.projectView
            : state.newTaskReturnView,
      };
    case 'closeNewTask':
      if (state.projectView !== 'new-task') return state;
      return { ...state, projectView: state.newTaskReturnView };
    case 'openPalette':
      return { ...state, paletteOpen: true };
    case 'closePalette':
      return { ...state, paletteOpen: false };
    case 'togglePalette':
      return { ...state, paletteOpen: !state.paletteOpen };
    case 'escape':
      if (state.paletteOpen) return { ...state, paletteOpen: false };
      if (state.peekTaskId !== null) return { ...state, peekTaskId: null };
      if (state.projectView === 'new-task')
        return { ...state, projectView: state.newTaskReturnView };
      return state;
    default:
      return state;
  }
}
