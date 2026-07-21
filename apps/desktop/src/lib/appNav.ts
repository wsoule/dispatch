// The whole app's navigation state, modeled as one pure reducer so routing decisions (what
// the sidebar highlights, what the main pane renders, whether the task peek/run
// split/command palette are open) are unit-testable without mounting React. App.tsx is the
// only place that owns a `useReducer(navReducer, initialNavState)` — every view/shell
// component below it receives plain props derived from this state plus dispatch callbacks,
// the same "dumb view, smart root" split TasksPanel used for the old dispatch-only pane.

/** The four primary views for whichever project is active — Board is the default/heart of
 * the app per the redesign brief; Tasks is the flat list, Runs is the split log/review
 * layout, Plans is the composer + proposal review. */
export type ProjectView = 'board' | 'tasks' | 'runs' | 'plans';

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
  paletteOpen: boolean;
}

export const initialNavState: NavState = {
  section: 'project',
  activeProjectId: null,
  projectView: 'board',
  globalView: 'sessions',
  peekTaskId: null,
  activeRunId: null,
  paletteOpen: false,
};

export type NavAction =
  | { type: 'selectProject'; projectId: string }
  | { type: 'setProjectView'; view: ProjectView }
  | { type: 'setGlobalView'; view: GlobalView }
  | { type: 'openPeek'; taskId: string }
  | { type: 'closePeek' }
  | { type: 'openRun'; runId: string }
  | { type: 'closeRun' }
  | { type: 'openPalette' }
  | { type: 'closePalette' }
  | { type: 'togglePalette' }
  /** Context-sensitive close: the command palette wins over the task peek (it renders on
   * top), and either one being open swallows the Escape entirely rather than also
   * clearing the other — a single Escape press should undo exactly one layer of UI. */
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
        projectView: 'board',
        peekTaskId: null,
        activeRunId: null,
      };
    case 'setProjectView':
      return {
        ...state,
        section: 'project',
        projectView: action.view,
        // Leaving Runs behind clears the split-pane selection so re-entering starts fresh
        // rather than reopening whatever run happened to be selected last time.
        activeRunId: action.view === 'runs' ? state.activeRunId : null,
      };
    case 'setGlobalView':
      return { ...state, section: 'global', globalView: action.view };
    case 'openPeek':
      return { ...state, peekTaskId: action.taskId };
    case 'closePeek':
      return { ...state, peekTaskId: null };
    case 'openRun':
      return { ...state, activeRunId: action.runId };
    case 'closeRun':
      return { ...state, activeRunId: null };
    case 'openPalette':
      return { ...state, paletteOpen: true };
    case 'closePalette':
      return { ...state, paletteOpen: false };
    case 'togglePalette':
      return { ...state, paletteOpen: !state.paletteOpen };
    case 'escape':
      if (state.paletteOpen) return { ...state, paletteOpen: false };
      if (state.peekTaskId !== null) return { ...state, peekTaskId: null };
      return state;
    default:
      return state;
  }
}
