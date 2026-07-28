// The whole app's navigation state, modeled as one pure reducer so routing decisions (what
// the sidebar highlights, what the main pane renders, whether the task peek/run
// split/command palette are open) are unit-testable without mounting React. App.tsx is the
// only place that owns a `useReducer(navReducer, initialNavState)` — every view/shell
// component below it receives plain props derived from this state plus dispatch callbacks,
// the same "dumb view, smart root" split TasksPanel used for the old dispatch-only pane.

/** The three primary views for whichever project is active. `board` is the single "Tasks"
 * destination — a Kanban/list toggle lives inside `BoardView` itself now rather than the old
 * separate `tasks` nav item (Linear doesn't split "board" and "issue list" into two places in
 * its own nav either); Runs is the split log/review layout, Plans is the composer + proposal
 * review. The `board` id is kept (rather than renamed to e.g. `tasks`) so this type, the
 * reducer below, and every test against it stay untouched by the nav collapse — only
 * `Sidebar`'s single nav row and its label changed.
 *
 * `new-task` is the odd one out: it's a full-page *destination* (the describe-what-you-want
 * task creator, Plans' single-task sibling) but not a nav *item* — `Sidebar` lists its rows
 * explicitly, so it never appears in the rail. You get there from a "New task" affordance and
 * leave via Escape/Cancel/save, which is why it has its own open/close actions below rather
 * than being reached through a plain `setProjectView`. */
export type ProjectView =
  | 'overview'
  | 'board'
  | 'milestones'
  | 'runs'
  | 'branches'
  | 'pull-requests'
  | 'landing'
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
  /** Where closing the full-page task creator returns to. Captured when it opens so
   * Escape/Cancel lands back on whatever you were looking at (a board column's "+" returns to
   * the board, the "c" shortcut pressed on Runs returns to Runs) instead of always dumping
   * you on one fixed view. */
  newTaskReturnView: ProjectView;
  paletteOpen: boolean;
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
};

export type NavAction =
  | { type: 'selectProject'; projectId: string }
  | { type: 'setProjectView'; view: ProjectView }
  | { type: 'setGlobalView'; view: GlobalView }
  | { type: 'openPeek'; taskId: string }
  | { type: 'closePeek' }
  | { type: 'openRun'; runId: string }
  | { type: 'closeRun' }
  /** Opens the full-page task creator, remembering the view to come back to. */
  | { type: 'openNewTask' }
  | { type: 'closeNewTask' }
  | { type: 'openPalette' }
  | { type: 'closePalette' }
  | { type: 'togglePalette' }
  /** Context-sensitive close: the command palette wins over the task peek (it renders on
   * top), which in turn wins over the full-page task creator (a whole view, so the outermost
   * layer), and each one being open swallows the Escape entirely rather than also clearing
   * the next — a single Escape press should undo exactly one layer of UI. */
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
    case 'setProjectView':
      return {
        ...state,
        section: 'project',
        projectView: action.view,
        // Runs and Pull requests both key their selection off `activeRunId` (a PR is just a
        // run with an open PR), so keep it when moving between those two; any other view
        // clears it so re-entering starts fresh rather than reopening a stale selection.
        activeRunId:
          action.view === 'runs' ||
          action.view === 'pull-requests' ||
          // Review is a full-page view OF the selected run, so moving into it must keep the
          // selection rather than clearing it and landing on an empty surface.
          action.view === 'review'
            ? state.activeRunId
            : null,
      };
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
      return { ...state, activeRunId: action.runId };
    case 'closeRun':
      return { ...state, activeRunId: null };
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
