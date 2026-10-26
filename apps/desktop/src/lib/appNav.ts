import type { GraphScope } from '@dispatch/planning';
import { graphScopeFor } from '@dispatch/planning';

import type { GlobalKeyCommand } from './keyboard';
import type { TaskPageMode } from './taskPageMode';
import type { TasksPreset } from './tasksPresets';

// The whole app's navigation, modeled as one pure reducer so routing decisions
// (what the sidebar highlights, what the main pane renders, whether the peek
// drawer, Settings, the composer, the palette or the shortcuts sheet is open)
// are unit-testable without mounting React. App.tsx is the only place that
// owns a `useReducer(navReducer, initialNavState)`; every view and shell
// component below it receives plain props derived from this state plus
// dispatch callbacks. `lib/routes.ts` writes a state as a hash href and reads
// one back as actions, so every place here is also a URL.
//
// The model is the Two views one: the main pane is the Overseer or Tasks, and
// Tasks shows its list or one page (a task, a doc, a PR, a draft, a room, a
// file, or a hosted view: Files, Terminals, Threads, Timeline, Graph, Projects,
// Live). A peek is a drawer over either view and never a place; Settings is a
// dialog over the views. The legacy project/global view vocabulary survives
// as `ProjectView` and `GlobalView`, mapped onto places by
// `projectViewDestination` and `globalViewDestination`, so the palette, the
// inbox and the key chords keep naming pages the old way.

/** The primary views for whichever project is active, as the palette, the
 * inbox and the key chords name them. Each maps to a place through
 * `projectViewDestination`. */
export type ProjectView =
  /** Home: Ready for you, In flight and Needs you — where a project opens. */
  | 'cockpit'
  | 'overview'
  | 'board'
  /** The projects register: every open project with its status, next
   * milestone, lead and allocation, grouped by initiative; a page under
   * Tasks, reached from the Projects section's "All". */
  | 'projects'
  /** Everything in motion at once: a Flight Plan band per container with work
   * moving; a page under Tasks, reached from the palette and the Runs page. */
  | 'live'
  /** retired — normalized to 'inbox' */
  | 'runs'
  /** retired — normalized to 'cockpit' */
  | 'branches'
  /** retired — normalized to 'landing' */
  | 'landed'
  /** The one merge-queue destination: every open PR with its gates, plus what
   * already landed — "what lands, when, and what landed". */
  | 'landing'
  /** retired — normalized to 'inbox' */
  | 'review'
  /** Slim list of everything waiting on a human — the surface that replaced
   * both retired pages. */
  | 'inbox'
  /** Conversations on the message bus: Needs you, Channels, Direct. */
  | 'threads'
  /** retired — normalized to 'cockpit' */
  | 'brain-dump'
  /** retired — normalized to 'cockpit' */
  | 'design'
  /** Browse and edit the checkout, with previews and quick open. */
  | 'files'
  /** Team documents beside tasks: specs, plans, runbooks, versioned and linked. */
  | 'docs'
  /** Shells on the repo or a run's worktree, split any number of ways. */
  | 'terminals'
  /** The Gantt of every project's milestones, grouped by initiative (Phase 4). */
  | 'timeline'
  /** The dependency graph at every level (initiatives, projects, milestones,
   * issues), a sidebar destination of its own (Phase 5). */
  | 'graph'
  /** retired — normalized to 'cockpit' */
  | 'plans'
  /** A single AI task draft's review page; it needs a draft id (`openDraft`). */
  | 'draft'
  /** One repo pull request, full-window; it needs a number (`openPr`). */
  | 'pr'
  /** retired — normalized to 'cockpit' */
  | 'impact'
  /** One task, full-window, on a mode that follows its state (`openTask`). */
  | 'task'
  /** The AI composer dialog (`openNewTask`); never a page. */
  | 'new-task';

/** Views that act on the host machine as the person running the daemon — a
 * shell, and a browser carrying their cookies. The daemon holds both to the
 * operator tier, so a teammate below it is not shown doors that only 403. */
export const HOST_VIEWS: ReadonlySet<ProjectView> = new Set(['terminals']);

/** Which mode the task page shows: `auto` follows the task's state (see
 * defaultTaskPageMode); `thread` is the task's message threads; `preview` is the
 * run's live app, full page only. */
export type TaskTab =
  | 'auto'
  | TaskPageMode
  | 'thread'
  | 'preview'
  | 'files'
  | 'terminal';

// Every TaskTab once, so a route's `?tab=` is checked against the type: adding
// a tab without listing it here fails in tsc.
const TASK_TAB_IDS = {
  auto: true,
  spec: true,
  run: true,
  review: true,
  summary: true,
  plan: true,
  thread: true,
  preview: true,
  files: true,
  terminal: true,
} satisfies Record<TaskTab, true>;

/** Every task page tab, for a route reading `?tab=`. */
export const TASK_TABS: readonly TaskTab[] = Object.keys(
  TASK_TAB_IDS
) as TaskTab[];

/** Global, not-project-scoped views living below the primary nav in the sidebar.
 * `overseer` is the chat assistant for the active project — it lives in this section
 * (not `ProjectView`) so it stays reachable from any view, but its conversation is
 * still scoped to whichever project is active. */
export type GlobalView = 'all-agents' | 'sessions' | 'overseer' | 'settings';

/** The pages of the Settings view, in its nav order. Lives here rather than in
 * `SettingsView` so a `setGlobalView('settings', { page })` can name one — the rail's
 * `Connect Linear` and the status strip's gear both land on Integrations. */
export type SettingsPage =
  | 'general'
  | 'agents'
  | 'checks'
  | 'autonomy'
  | 'memory'
  | 'previews'
  | 'notifications'
  | 'team'
  | 'connected-agents'
  | 'sync'
  | 'integrations'
  | 'a2a'
  | 'license'
  | 'remotes'
  | 'daemon'
  | 'diffs'
  | 'setup';

/** Settings' own pages plus the two global views that fold into it: Sessions
 * is the Usage page, All agents the Runs page. */
export type NavSettingsPage = SettingsPage | 'usage' | 'runs';

// Every NavSettingsPage once, so a route's `#/settings/<page>` is checked
// against the type: adding a page without listing it here fails in tsc.
const SETTINGS_PAGE_IDS = {
  general: true,
  agents: true,
  checks: true,
  autonomy: true,
  memory: true,
  previews: true,
  notifications: true,
  team: true,
  'connected-agents': true,
  sync: true,
  integrations: true,
  a2a: true,
  license: true,
  remotes: true,
  daemon: true,
  diffs: true,
  setup: true,
  usage: true,
  runs: true,
} satisfies Record<NavSettingsPage, true>;

/** Every Settings page a route may open, for `#/settings/<page>`. */
export const NAV_SETTINGS_PAGES: readonly NavSettingsPage[] = Object.keys(
  SETTINGS_PAGE_IDS
) as NavSettingsPage[];

/** Which side of the main pane shows: the Overseer, or Tasks. */
export type MainView = 'overseer' | 'tasks';

/** The Issues list's layouts. The dependency graph is a page of its own
 * (`HostedView` 'graph'), not a layout of the list. */
export type TasksMode = 'list' | 'board';

/** Project views shown as a page under Tasks, led by "‹ tasks". Timeline,
 * Graph and Threads have sidebar rows of their own; Projects (the register)
 * opens from the Projects section's "All", Live from the palette and the Runs
 * page. */
export type HostedView = Extract<
  ProjectView,
  'files' | 'terminals' | 'threads' | 'timeline' | 'graph' | 'projects' | 'live'
>;

/** A hosted view as a page, with the parameters its route carries: the
 * Timeline's focused project lane (`#/timeline?project=`) and the Graph's
 * scope and arrival box (`#/graph?project=…&node=…`). */
export type HostedPage =
  | {
      kind: 'view';
      view: Exclude<HostedView, 'timeline' | 'graph'>;
    }
  | {
      kind: 'view';
      view: 'timeline';
      /** The project whose lane is brought into view and marked, or null. */
      project: string | null;
    }
  | {
      kind: 'view';
      view: 'graph';
      scope: GraphScope;
      /** The box to select on arrival, when the link named one. */
      nodeId: string | null;
    };

/** What the Tasks view shows instead of its list. A task here is always the
 * full page: a quick look at a task is a `Peek`, over whichever view shows. */
export type TasksPage =
  | { kind: 'list' }
  | {
      kind: 'task';
      taskId: string;
      tab: TaskTab;
      runId: string | null;
    }
  | {
      kind: 'docs';
      docId: string | null;
      anchor: string | null;
      merge: string | null;
    }
  | { kind: 'pr'; number: number }
  | { kind: 'draft'; draftId: string }
  /** A named room, reached by name, never listed. */
  | { kind: 'room'; room: string }
  | HostedPage
  /** The Files page opened on one file, e.g. from a file link in a thread. */
  | { kind: 'file'; path: string };

/** A drawer over either view; it never changes the view underneath. A task
 * peek is the quick-look slide-over (a row click, Space, "Quick look"). */
type Peek =
  | { kind: 'thread'; messageId: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'person'; address: string }
  | { kind: 'outside'; address: string };

/** One visited destination: the view, and the page under Tasks. */
export interface Place {
  mainView: MainView;
  tasksPage: TasksPage;
}

export interface NavState extends Place {
  /** The last project selected via the project switcher, or `null` before any project has
   * ever resolved as dispatch-enabled (the get-started/first-run state). */
  activeProjectId: string | null;
  tasksMode: TasksMode;
  /** What the list and board show: All, or one question like Needs you or Failed. */
  tasksPreset: TasksPreset;
  peek: Peek | null;
  /** The open Settings page, or `null` while Settings is closed. */
  settings: NavSettingsPage | null;
  /** Whether the AI task composer dialog is open. A dialog over whatever
   * shows, never a place: history and the hash ignore it. */
  composerOpen: boolean;
  paletteOpen: boolean;
  /** Whether the keyboard-shortcuts reference (`?`) is open. */
  shortcutsOpen: boolean;
  /**
   * Where you have been, newest last, and how far back you have stepped.
   *
   * Without this every "back" affordance had to name one fixed destination, so
   * closing a page always went to the same place regardless of where you
   * opened it from. An index rather than popping, so forward still works after
   * going back.
   */
  history: Place[];
  historyIndex: number;
}

export type NavAction =
  | { type: 'selectProject'; projectId: string }
  /** A legacy page name: lands where `projectViewDestination` says. */
  | { type: 'setProjectView'; view: ProjectView }
  /** `page` lands Settings on one of its pages; without it Settings keeps the last page
   * asked for. Ignored for every other global view. */
  | { type: 'setGlobalView'; view: GlobalView; page?: SettingsPage }
  | { type: 'openPeek'; taskId: string }
  | { type: 'closePeek' }
  /** Pins the open task page's Run and Review modes to one run. */
  | { type: 'openRun'; runId: string }
  | { type: 'closeRun' }
  /** Routes to the draft review page for one draft — the drafts tray's row click. */
  | { type: 'openDraft'; draftId: string }
  /** Routes to the PR review page for one repo pull request — the Inbox's PR
   * rows and a run's "Review PR" button. */
  | { type: 'openPr'; number: number }
  /** Quick-looks the thread holding `messageId` in the peek drawer; `null`
   * (no thread) is the Overseer, where the talk lives. */
  | { type: 'openThread'; messageId: string | null }
  /** Routes to Docs with one doc open, scrolled to `anchor`'s section when set —
   * a task page's Docs row, a `doc:` ref chip, or a palette hit. */
  | { type: 'openDoc'; docId: string; anchor: string | null; merge?: string }
  /** Routes to the task's full page with a specific tab and optional run. */
  | { type: 'openTask'; taskId: string; tab?: TaskTab; runId?: string | null }
  /** Switches the tab within the task page without adding a history entry. */
  | { type: 'setTaskTab'; tab: TaskTab }
  /** Opens the AI composer dialog over whatever shows. */
  | { type: 'openNewTask' }
  | { type: 'closeNewTask' }
  | { type: 'openPalette' }
  | { type: 'closePalette' }
  | { type: 'togglePalette' }
  /** The `?` shortcuts reference — a dialog, so it stacks over whatever is open. */
  | { type: 'openShortcuts' }
  | { type: 'closeShortcuts' }
  | { type: 'back' }
  | { type: 'forward' }
  /** Context-sensitive close: the dialogs (shortcuts, palette, composer) win
   * over Settings, Settings over the peek, the peek over a page under Tasks,
   * and each one open swallows the Escape rather than also clearing the next
   * layer. */
  | { type: 'escape' }
  | { type: 'showOverseer' }
  /** Tasks on its list, narrowed to `preset`; without one, back to where Tasks
   * was left (or to the list, when already there) with the filter cleared. */
  | { type: 'showTasks'; preset?: TasksPreset }
  | { type: 'setTasksPreset'; preset: TasksPreset }
  | { type: 'setTasksMode'; mode: TasksMode }
  | { type: 'openSettings'; page?: NavSettingsPage }
  | { type: 'closeSettings' }
  /** Closes the page under Tasks: back to the list. */
  | { type: 'closePage' }
  /** The Files page opened on one file. */
  | { type: 'openFile'; path: string }
  /** Opens a person, an outside agent, a room or a task by address. */
  | { type: 'openAddress'; address: string }
  /** The Timeline, with one project's lane in view when `project` names it. */
  | { type: 'openTimeline'; project: string | null }
  /** The Graph on one scope, with `nodeId`'s box selected on arrival. */
  | { type: 'openGraph'; scope: GraphScope; nodeId: string | null };

/** Where a legacy view name lands: the Overseer, Tasks' list, a page under
 * Tasks, a Settings page, or nowhere (a record page without its id). */
export type NavDestination =
  | { kind: 'overseer' }
  | { kind: 'tasks' }
  | { kind: 'docs' }
  | { kind: 'settings'; page: NavSettingsPage }
  | { kind: 'page'; page: TasksPage }
  | { kind: 'none' };

const LIST: TasksPage = { kind: 'list' };

/** Where the Graph opens with nothing named: the workspace's milestones. */
export const DEFAULT_GRAPH_SCOPE: GraphScope = graphScopeFor({
  kind: 'workspace',
});

export const initialNavState: NavState = {
  activeProjectId: null,
  mainView: 'overseer',
  tasksPage: LIST,
  tasksMode: 'list',
  tasksPreset: 'all',
  peek: null,
  settings: null,
  composerOpen: false,
  paletteOpen: false,
  shortcutsOpen: false,
  history: [{ mainView: 'overseer', tasksPage: LIST }],
  historyIndex: 0,
};

/** Where a project view lives: Overseer, Tasks, or a page under Tasks. */
export function projectViewDestination(view: ProjectView): NavDestination {
  switch (view) {
    case 'cockpit':
    case 'overview':
    case 'board':
    case 'inbox':
    case 'landing':
    case 'runs':
    case 'review':
    case 'landed':
      return { kind: 'tasks' };
    case 'docs':
      return { kind: 'docs' };
    case 'files':
    case 'terminals':
    case 'threads':
    case 'projects':
    case 'live':
      return { kind: 'page', page: { kind: 'view', view } };
    case 'timeline':
      return {
        kind: 'page',
        page: { kind: 'view', view: 'timeline', project: null },
      };
    case 'graph':
      return {
        kind: 'page',
        page: {
          kind: 'view',
          view: 'graph',
          scope: DEFAULT_GRAPH_SCOPE,
          nodeId: null,
        },
      };
    // Retired pages: plans and notes live in the Overseer now; the rest had no successor.
    case 'plans':
    case 'brain-dump':
      return { kind: 'overseer' };
    case 'branches':
    case 'impact':
    case 'design':
      return { kind: 'tasks' };
    // These name a record; without its id there is nowhere to go.
    case 'task':
    case 'pr':
    case 'draft':
    case 'new-task':
      return { kind: 'none' };
    default: {
      const unhandled: never = view;
      return unhandled;
    }
  }
}

/** Where a global view lives: Overseer, or a Settings page. */
export function globalViewDestination(
  view: GlobalView,
  page?: SettingsPage
): NavDestination {
  switch (view) {
    case 'overseer':
      return { kind: 'overseer' };
    case 'settings':
      return { kind: 'settings', page: page ?? 'general' };
    case 'sessions':
      return { kind: 'settings', page: 'usage' };
    case 'all-agents':
      return { kind: 'settings', page: 'runs' };
    default: {
      const unhandled: never = view;
      return unhandled;
    }
  }
}

// ⌘3–⌘9: the status chips' presets, in strip order. Listed rather than
// sliced from TASKS_PRESETS so a new preset (Mine, Starred) never shifts a key.
const DIGIT_PRESETS: readonly TasksPreset[] = [
  'needs-you',
  'failed',
  'moving',
  'review',
  'ready',
  'landing',
  'landed',
];

/** What a global key does: a navigation, `'swallow'` for a key with nothing
 * to do here, or `null` to fall through to the shared handling in App. */
export function keyAction(
  command: GlobalKeyCommand
): NavAction | 'swallow' | null {
  switch (command) {
    case 'goto-1':
    case 'goto-overseer':
    case 'goto-home':
    case 'goto-control-room':
      return { type: 'showOverseer' };
    case 'goto-2':
    case 'goto-tasks':
      return { type: 'showTasks' };
    case 'goto-inbox':
      return { type: 'showTasks', preset: 'needs-you' };
    case 'goto-live':
      return { type: 'showTasks', preset: 'moving' };
    case 'goto-projects':
      return { type: 'showTasks', preset: 'review' };
    case 'goto-threads':
      return { type: 'setProjectView', view: 'threads' };
    case 'goto-timeline':
      return { type: 'openTimeline', project: null };
    case 'goto-graph':
      return { type: 'openGraph', scope: DEFAULT_GRAPH_SCOPE, nodeId: null };
    case 'goto-settings':
      return { type: 'openSettings' };
    // ⌘3–⌘9 walk the status presets, in chip order.
    case 'goto-3':
    case 'goto-4':
    case 'goto-5':
    case 'goto-6':
    case 'goto-7':
    case 'goto-8':
    case 'goto-9': {
      const preset = DIGIT_PRESETS[Number(command.slice(5)) - 3];
      return preset === undefined ? 'swallow' : { type: 'showTasks', preset };
    }
    // `toggle-sidebar` is the shell's: App collapses the rail itself.
    default:
      return null;
  }
}

/** A page's identity as a string, keys in a fixed order, so two pages built
 * by different callers (a link's parsed scope, a reducer default) compare
 * equal when they name the same place. */
function pageKey(page: TasksPage): string {
  return JSON.stringify(page, (_key, value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0
          )
        )
      : value
  );
}

export function samePlace(a: Place, b: Place): boolean {
  return (
    a.mainView === b.mainView && pageKey(a.tasksPage) === pageKey(b.tasksPage)
  );
}

// Moves to a place, records it, and closes Settings: any navigation leaves
// Settings. Re-selecting the place you are already on is not a new
// destination; navigating somewhere new after going back discards what you
// had gone back from (the browser rule).
function go(state: NavState, place: Place): NavState {
  const moved = { ...state, ...place, settings: null };
  const kept = state.history.slice(0, state.historyIndex + 1);
  const last = kept[kept.length - 1];
  if (last !== undefined && samePlace(last, place)) return moved;
  const history = [...kept, place].slice(-50);
  return { ...moved, history, historyIndex: history.length - 1 };
}

function toTasks(state: NavState, page: TasksPage): NavState {
  return go(state, { mainView: 'tasks', tasksPage: page });
}

function applyDestination(
  state: NavState,
  destination: NavDestination
): NavState {
  switch (destination.kind) {
    case 'overseer':
      return go(state, { mainView: 'overseer', tasksPage: state.tasksPage });
    case 'tasks':
      return toTasks(state, LIST);
    case 'docs':
      return toTasks(state, {
        kind: 'docs',
        docId: null,
        anchor: null,
        merge: null,
      });
    case 'settings':
      return { ...state, settings: destination.page };
    case 'page':
      return toTasks(state, destination.page);
    case 'none':
      return state;
  }
}

// Patches the open task page in place (a tab flip, a run pick): not a
// destination, so history keeps the page as it was opened. Off the page it
// does nothing.
function withTaskPage(
  state: NavState,
  patch: Partial<Extract<TasksPage, { kind: 'task' }>>
): NavState {
  const page = state.tasksPage;
  if (page.kind !== 'task') return state;
  return { ...state, tasksPage: { ...page, ...patch } };
}

// Where an address leads: people, outside agents and tasks peek (a task by
// address is a quick look); rooms open under Tasks.
function openAddress(state: NavState, address: string): NavState {
  const colon = address.indexOf(':');
  const kind = address.slice(0, colon);
  const rest = address.slice(colon + 1);
  switch (kind) {
    case 'human':
      return { ...state, peek: { kind: 'person', address } };
    case 'a2a':
      return { ...state, peek: { kind: 'outside', address } };
    case 'channel':
      return toTasks(state, { kind: 'room', room: rest });
    case 'task':
      return { ...state, peek: { kind: 'task', taskId: rest } };
    default:
      return state;
  }
}

// Moving through history is navigation, not a modal action: anything layered
// on top (a peek, Settings, the palette, the shortcuts sheet) closes rather
// than following you to the new screen. Cmd+[ and Cmd+] are modifier chords,
// so they fire with those open (lib/keyboard.ts resolves them before the
// modal check). The AI composer stays: it holds text the person typed.
function step(state: NavState, delta: -1 | 1): NavState {
  const index = state.historyIndex + delta;
  const entry = state.history[index];
  if (entry === undefined) return state;
  return {
    ...state,
    ...entry,
    historyIndex: index,
    peek: null,
    settings: null,
    paletteOpen: false,
    shortcutsOpen: false,
  };
}

export function navReducer(state: NavState, action: NavAction): NavState {
  switch (action.type) {
    case 'selectProject':
      // Switching projects drops every page, peek, dialog and Settings scoped
      // to the previous project rather than carrying over an id that belongs
      // to a different project's task list; the view (Overseer or Tasks) and
      // the list's layout are the person's choice and stay.
      return {
        ...initialNavState,
        activeProjectId: action.projectId,
        mainView: state.mainView,
        tasksMode: state.tasksMode,
        history: [{ mainView: state.mainView, tasksPage: LIST }],
      };
    case 'setProjectView':
      return applyDestination(state, projectViewDestination(action.view));
    case 'setGlobalView':
      return applyDestination(
        state,
        globalViewDestination(action.view, action.page)
      );
    case 'openPeek':
      // The quick-look slide-over, over whichever view is showing (owner
      // decision, Phase 3a: no split pane beside the list any more).
      return { ...state, peek: { kind: 'task', taskId: action.taskId } };
    case 'closePeek':
      return state.peek === null ? state : { ...state, peek: null };
    case 'openRun':
      return withTaskPage(state, { runId: action.runId });
    case 'closeRun':
      return withTaskPage(state, { runId: null });
    case 'openTask':
      // The full page replaces a quick look of any task, so the drawer closes.
      return {
        ...toTasks(state, {
          kind: 'task',
          taskId: action.taskId,
          tab: action.tab ?? 'auto',
          runId: action.runId ?? null,
        }),
        peek: null,
      };
    case 'setTaskTab':
      return withTaskPage(state, { tab: action.tab });
    case 'openThread':
      return action.messageId === null
        ? applyDestination(state, { kind: 'overseer' })
        : { ...state, peek: { kind: 'thread', messageId: action.messageId } };
    case 'openDoc':
      return toTasks(state, {
        kind: 'docs',
        docId: action.docId,
        anchor: action.anchor,
        merge: action.merge ?? null,
      });
    case 'openPr':
      return toTasks(state, { kind: 'pr', number: action.number });
    case 'openDraft':
      return toTasks(state, { kind: 'draft', draftId: action.draftId });
    case 'openFile':
      return toTasks(state, { kind: 'file', path: action.path });
    case 'openTimeline':
      return toTasks(state, {
        kind: 'view',
        view: 'timeline',
        project: action.project,
      });
    case 'openGraph':
      return toTasks(state, {
        kind: 'view',
        view: 'graph',
        scope: action.scope,
        nodeId: action.nodeId,
      });
    case 'back':
      // A peek is the nearest thing to leave: back closes it rather than
      // leaving it over another page.
      if (state.peek !== null) return { ...state, peek: null };
      return step(state, -1);
    case 'forward':
      return step(state, 1);
    case 'escape':
      if (state.shortcutsOpen) return { ...state, shortcutsOpen: false };
      if (state.paletteOpen) return { ...state, paletteOpen: false };
      if (state.composerOpen) return { ...state, composerOpen: false };
      if (state.settings !== null) return { ...state, settings: null };
      if (state.peek !== null) return { ...state, peek: null };
      // A page you arrive at from a row leaves the way you came in, rather
      // than stranding you with only a Back button.
      if (state.mainView === 'tasks' && state.tasksPage.kind !== 'list') {
        return toTasks(state, LIST);
      }
      return state;
    case 'showOverseer':
      return applyDestination(state, { kind: 'overseer' });
    case 'showTasks':
      if (action.preset !== undefined)
        return { ...toTasks(state, LIST), tasksPreset: action.preset };
      // Coming from Overseer returns to where Tasks was left; pressing Tasks
      // while already there goes back to the list, like any tab pressed twice.
      return state.mainView === 'tasks'
        ? { ...toTasks(state, LIST), tasksPreset: 'all' }
        : {
            ...go(state, { mainView: 'tasks', tasksPage: state.tasksPage }),
            tasksPreset: 'all',
          };
    case 'setTasksPreset':
      return { ...state, tasksPreset: action.preset };
    case 'setTasksMode':
      return { ...state, tasksMode: action.mode };
    case 'openSettings':
      return { ...state, settings: action.page ?? 'general' };
    case 'closeSettings':
      return state.settings === null ? state : { ...state, settings: null };
    case 'closePage':
      return toTasks(state, LIST);
    case 'openAddress':
      return openAddress(state, action.address);
    case 'openNewTask':
      // A dialog over whatever shows, so it never records a place: closing it
      // leaves you exactly where you were.
      return state.composerOpen ? state : { ...state, composerOpen: true };
    case 'closeNewTask':
      return state.composerOpen ? { ...state, composerOpen: false } : state;
    case 'openPalette':
      return { ...state, paletteOpen: true };
    case 'closePalette':
      return { ...state, paletteOpen: false };
    case 'togglePalette':
      return { ...state, paletteOpen: !state.paletteOpen };
    case 'openShortcuts':
      // The reference is help, not a destination — it opens over the palette rather than
      // replacing it, and history never records it.
      return { ...state, shortcutsOpen: true };
    case 'closeShortcuts':
      return { ...state, shortcutsOpen: false };
    default: {
      const unhandled: never = action;
      return unhandled;
    }
  }
}
