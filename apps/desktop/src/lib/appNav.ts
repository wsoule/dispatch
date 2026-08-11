import type { ImpactSubjectKind } from '@dispatch/client';

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
  /** retired — normalized to 'inbox' */
  | 'runs'
  | 'branches'
  /** retired — normalized to 'inbox' */
  | 'review'
  /** Slim list of everything waiting on a human — the surface that replaced
   * both retired pages. */
  | 'inbox'
  | 'brain-dump'
  | 'plans'
  /** A single AI task draft's review page — `activeDraftId` says which one. */
  | 'draft'
  /** One repo pull request, full-window — `activePrNumber` says which. */
  | 'pr'
  /** The blast-radius browser — `impactSubject` says which file/run/task, or
   * `null` for the picker with nothing preselected. */
  | 'impact'
  /** One task, full-window, with Details/Chat/Diff tabs — `activeTaskId` says which. */
  | 'task'
  | 'new-task';

export type TaskTab = 'details' | 'chat' | 'diff';

/** One file/run/task to show the blast radius of — what `ImpactView` fetches
 * and what the two "open in Impact" entry points (Review case panel, Git
 * file pane) hand it preselected. */
export interface ImpactSubjectRef {
  kind: ImpactSubjectKind;
  id: string;
}

/** Global, not-project-scoped views living below the primary nav in the sidebar.
 * `warden` is the chat assistant for the active project — it lives in this section
 * (not `ProjectView`) so it stays reachable from any view, but its conversation is
 * still scoped to whichever project is active. */
export type GlobalView = 'all-agents' | 'sessions' | 'warden' | 'settings';

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
  /** Run id the task view's Chat/Diff tabs are pinned to, or `null` when none is selected. */
  activeRunId: string | null;
  /** Draft id shown by the draft view, or `null` when none is selected. */
  activeDraftId: string | null;
  /** Repo PR number shown by the PR review view, or `null` when none is open. */
  activePrNumber: number | null;
  /** The subject `ImpactView` is showing, or `null` for the picker with
   * nothing preselected — set by `openImpact`, the two entry points' way
   * of handing over "open in Impact" with a subject already chosen. */
  impactSubject: ImpactSubjectRef | null;
  /** Task id shown in the task full-window view, or `null` when it's not the current view. */
  activeTaskId: string | null;
  /** The current tab within the task view. */
  taskTab: TaskTab;
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

/** One visited destination. Every id a page renders from travels with the
 * entry — going back to a review you had open should reopen it. */
interface NavEntry {
  section: 'project' | 'global';
  projectView: ProjectView;
  globalView: GlobalView;
  activeRunId: string | null;
  activeDraftId: string | null;
  activePrNumber: number | null;
  impactSubject: ImpactSubjectRef | null;
  activeTaskId: string | null;
  taskTab: TaskTab;
}

/** The Runs and Review pages were retired by the task-centric consolidation
 * (2026-08-10); their ids survive so stored nav state and deep links land on
 * the Inbox instead of rendering nothing. */
function normalizeProjectView(view: ProjectView): ProjectView {
  return view === 'runs' || view === 'review' ? 'inbox' : view;
}

export const initialNavState: NavState = {
  section: 'project',
  activeProjectId: null,
  projectView: 'overview',
  globalView: 'sessions',
  peekTaskId: null,
  activeRunId: null,
  activeDraftId: null,
  activePrNumber: null,
  impactSubject: null,
  activeTaskId: null,
  taskTab: 'details',
  newTaskReturnView: 'board',
  paletteOpen: false,
  history: [
    {
      section: 'project',
      projectView: 'overview',
      globalView: 'sessions',
      activeRunId: null,
      activeDraftId: null,
      activePrNumber: null,
      impactSubject: null,
      activeTaskId: null,
      taskTab: 'details',
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
    last.activeRunId === next.activeRunId &&
    last.activeDraftId === next.activeDraftId &&
    last.activePrNumber === next.activePrNumber &&
    last.impactSubject?.kind === next.impactSubject?.kind &&
    last.impactSubject?.id === next.impactSubject?.id &&
    last.activeTaskId === next.activeTaskId &&
    last.taskTab === next.taskTab
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
  /** Routes to the draft review page for one draft — the drafts tray's row click. */
  | { type: 'openDraft'; draftId: string }
  /** Routes to the PR review page for one repo pull request — the Inbox's PR
   * rows and a run's "Review PR" button. */
  | { type: 'openPr'; number: number }
  /** Routes to `ImpactView` with a subject preselected — the "open in Impact"
   * action on the Review case panel and the Git file pane. */
  | { type: 'openImpact'; subject: ImpactSubjectRef }
  /** Routes to the task full-window view with a specific task, tab, and optional run. */
  | { type: 'openTask'; taskId: string; tab?: TaskTab; runId?: string | null }
  /** Switches the tab within the task view without adding a history entry. */
  | { type: 'setTaskTab'; tab: TaskTab }
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
        activeDraftId: null,
        activePrNumber: null,
        impactSubject: null,
        activeTaskId: null,
      };
    case 'setProjectView': {
      const view = normalizeProjectView(action.view);
      // The task view is the only page that renders a selected run now, so
      // every other destination clears it rather than reopening a stale one.
      const activeRunId = view === 'task' ? state.activeRunId : null;
      // Only the draft view itself renders a selected draft, so any other
      // destination drops it rather than reopening a stale one on return.
      const activeDraftId = view === 'draft' ? state.activeDraftId : null;
      // Same rule for the open pull request: only the PR view renders one.
      const activePrNumber = view === 'pr' ? state.activePrNumber : null;
      // Same rule as the draft id: only Impact itself renders a preselected
      // subject, so leaving it drops a stale one rather than reopening it
      // the next time the nav item is clicked fresh.
      const impactSubject = view === 'impact' ? state.impactSubject : null;
      const activeTaskId = view === 'task' ? state.activeTaskId : null;
      const next: NavState = {
        ...state,
        section: 'project',
        projectView: view,
        activeRunId,
        activeDraftId,
        activePrNumber,
        impactSubject,
        activeTaskId,
        taskTab: state.taskTab,
      };
      return pushHistory(next, {
        section: 'project',
        projectView: view,
        globalView: state.globalView,
        activeRunId,
        activeDraftId,
        activePrNumber,
        impactSubject,
        activeTaskId,
        taskTab: state.taskTab,
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
          activeDraftId: state.activeDraftId,
          activePrNumber: state.activePrNumber,
          impactSubject: state.impactSubject,
          activeTaskId: state.activeTaskId,
          taskTab: state.taskTab,
        }
      );
    case 'closeRun':
      return { ...state, activeRunId: null };
    case 'openDraft':
      // Opening a different draft is a destination in its own right, so back
      // returns to the one you were looking at rather than skipping the view.
      return pushHistory(
        {
          ...state,
          section: 'project',
          projectView: 'draft',
          activeDraftId: action.draftId,
        },
        {
          section: 'project',
          projectView: 'draft',
          globalView: state.globalView,
          activeRunId: state.activeRunId,
          activeDraftId: action.draftId,
          activePrNumber: state.activePrNumber,
          impactSubject: state.impactSubject,
          activeTaskId: state.activeTaskId,
          taskTab: state.taskTab,
        }
      );
    case 'openPr':
      // Same rule as `openDraft`: one PR is a destination, so back returns to
      // the pull request you had open rather than skipping past the view.
      return pushHistory(
        {
          ...state,
          section: 'project',
          projectView: 'pr',
          activePrNumber: action.number,
        },
        {
          section: 'project',
          projectView: 'pr',
          globalView: state.globalView,
          activeRunId: state.activeRunId,
          activeDraftId: state.activeDraftId,
          activePrNumber: action.number,
          impactSubject: state.impactSubject,
          activeTaskId: state.activeTaskId,
          taskTab: state.taskTab,
        }
      );
    case 'openImpact':
      // Opening a different subject is a destination in its own right, so
      // back returns to the one you were looking at rather than skipping
      // straight past the view — same rule `openRun`/`openDraft` follow.
      return pushHistory(
        {
          ...state,
          section: 'project',
          projectView: 'impact',
          impactSubject: action.subject,
        },
        {
          section: 'project',
          projectView: 'impact',
          globalView: state.globalView,
          activeRunId: state.activeRunId,
          activeDraftId: state.activeDraftId,
          activePrNumber: state.activePrNumber,
          impactSubject: action.subject,
          activeTaskId: state.activeTaskId,
          taskTab: state.taskTab,
        }
      );
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
        activeDraftId: entry.activeDraftId,
        activePrNumber: entry.activePrNumber,
        impactSubject: entry.impactSubject,
        activeTaskId: entry.activeTaskId,
        taskTab: entry.taskTab,
        // Moving through history is navigation, not a modal action — anything
        // layered on top closes rather than following you to the new screen.
        peekTaskId: null,
        paletteOpen: false,
      };
    }
    case 'openTask': {
      // The full task view is a destination (unlike the peek): it replaces the
      // main pane and participates in history, so back returns to where you were.
      const next: NavState = {
        ...state,
        section: 'project',
        projectView: 'task',
        activeTaskId: action.taskId,
        taskTab: action.tab ?? 'details',
        activeRunId: action.runId ?? null,
        peekTaskId: null,
      };
      return pushHistory(next, {
        section: 'project',
        projectView: 'task',
        globalView: state.globalView,
        activeRunId: next.activeRunId,
        activeDraftId: state.activeDraftId,
        activePrNumber: state.activePrNumber,
        impactSubject: state.impactSubject,
        activeTaskId: action.taskId,
        taskTab: next.taskTab,
      });
    }
    case 'setTaskTab':
      // Tab flips are in-place, not destinations — history keeps the tab the
      // view was opened on.
      return state.projectView === 'task'
        ? { ...state, taskTab: action.tab }
        : state;
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
        // Normalized on capture, so a return view read out of stored state can
        // never send you back to a page that no longer exists.
        newTaskReturnView:
          state.projectView !== 'new-task'
            ? normalizeProjectView(state.projectView)
            : normalizeProjectView(state.newTaskReturnView),
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
      // The full-window destinations you arrive at from a row click leave the
      // way you came in, rather than stranding you with only a Back button.
      if (
        state.section === 'project' &&
        (state.projectView === 'task' || state.projectView === 'pr')
      ) {
        return navReducer(state, { type: 'back' });
      }
      return state;
    default:
      return state;
  }
}
