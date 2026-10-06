import type {
  GlobalView,
  ImpactSubjectRef,
  NavAction,
  NavState,
  ProjectView,
  SettingsPage,
  TaskTab,
} from './appNav';
import { initialNavState, navReducer } from './appNav';
import type { TasksPreset } from './tasksPresets';

// Two views' navigation: App dispatches every legacy NavAction here as well as to
// navReducer, and this reducer maps each destination to Overseer, Tasks or a peek.

export type MainView = 'overseer' | 'tasks';
export type TasksMode = 'list' | 'graph';

/** Settings' own pages plus the three global views that fold into it. */
type TwoViewsSettingsPage = SettingsPage | 'usage' | 'runs' | 'developer';

/** Classic project views Two views shows as a page under Tasks, led by "‹ tasks". */
export type HostedView = Extract<
  ProjectView,
  'branches' | 'files' | 'terminals' | 'design' | 'brain-dump'
>;

/** What the Tasks view shows beside or instead of its list. */
export type TasksPage =
  | { kind: 'list' }
  | {
      kind: 'task';
      taskId: string;
      tab: TaskTab;
      runId: string | null;
      full: boolean;
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
  | { kind: 'view'; view: HostedView }
  | { kind: 'impact'; subject: ImpactSubjectRef | null };

/** A drawer over either view; it never changes the view underneath. */
type Peek =
  | { kind: 'thread'; messageId: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'person'; address: string }
  | { kind: 'outside'; address: string };

interface Place {
  mainView: MainView;
  tasksPage: TasksPage;
}

export interface TwoViewsState extends Place {
  tasksMode: TasksMode;
  /** What the list and graph show: All, or one question like Needs you or Failed. */
  tasksPreset: TasksPreset;
  peek: Peek | null;
  /** The open Settings page, or `null` while Settings is closed. */
  settings: TwoViewsSettingsPage | null;
  history: Place[];
  historyIndex: number;
}

export type TwoViewsAction =
  | { type: 'tv/showOverseer' }
  | { type: 'tv/showTasks'; preset?: TasksPreset }
  | { type: 'tv/setTasksPreset'; preset: TasksPreset }
  | { type: 'tv/setTasksMode'; mode: TasksMode }
  | { type: 'tv/openSettings'; page?: TwoViewsSettingsPage }
  | { type: 'tv/closeSettings' }
  | { type: 'tv/closePeek' }
  | { type: 'tv/closePage' }
  | { type: 'tv/expandTask' }
  /** Opens a person, an outside agent, a room or a task by address. */
  | { type: 'tv/openAddress'; address: string };

export type TwoViewsDestination =
  | { kind: 'overseer' }
  | { kind: 'tasks' }
  | { kind: 'docs' }
  | { kind: 'settings'; page: TwoViewsSettingsPage }
  | { kind: 'page'; page: TasksPage }
  | { kind: 'none' };

const LIST: TasksPage = { kind: 'list' };

export const initialTwoViewsState: TwoViewsState = {
  mainView: 'overseer',
  tasksPage: LIST,
  tasksMode: 'list',
  tasksPreset: 'all',
  peek: null,
  settings: null,
  history: [{ mainView: 'overseer', tasksPage: LIST }],
  historyIndex: 0,
};

/** Where a classic project view lives in Two views. */
export function projectViewDestination(view: ProjectView): TwoViewsDestination {
  switch (view) {
    case 'cockpit':
    case 'overview':
    case 'board':
    case 'projects':
    case 'live':
    case 'inbox':
    case 'landing':
    case 'runs':
    case 'review':
    case 'landed':
      return { kind: 'tasks' };
    case 'docs':
      return { kind: 'docs' };
    case 'branches':
    case 'files':
    case 'terminals':
    case 'design':
    case 'brain-dump':
      return { kind: 'page', page: { kind: 'view', view } };
    case 'impact':
      return { kind: 'page', page: { kind: 'impact', subject: null } };
    // Planning is a conversation with the agent, ending in one create_plan card;
    // threads are that conversation, so there is no list of them.
    case 'plans':
    case 'threads':
      return { kind: 'overseer' };
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

/** Where a classic global view lives in Two views. */
export function globalViewDestination(
  view: GlobalView,
  page?: SettingsPage
): TwoViewsDestination {
  switch (view) {
    case 'overseer':
      return { kind: 'overseer' };
    case 'settings':
      return { kind: 'settings', page: page ?? 'general' };
    case 'sessions':
      return { kind: 'settings', page: 'usage' };
    case 'all-agents':
      return { kind: 'settings', page: 'runs' };
    case 'gallery':
      return { kind: 'settings', page: 'developer' };
    default: {
      const unhandled: never = view;
      return unhandled;
    }
  }
}

function samePlace(a: Place, b: Place): boolean {
  return (
    a.mainView === b.mainView &&
    JSON.stringify(a.tasksPage) === JSON.stringify(b.tasksPage)
  );
}

// Moves to a place, records it, and closes Settings: any navigation leaves Settings.
function go(state: TwoViewsState, place: Place): TwoViewsState {
  const moved = { ...state, ...place, settings: null };
  const kept = state.history.slice(0, state.historyIndex + 1);
  const last = kept[kept.length - 1];
  if (last !== undefined && samePlace(last, place)) return moved;
  const history = [...kept, place].slice(-50);
  return { ...moved, history, historyIndex: history.length - 1 };
}

function toTasks(state: TwoViewsState, page: TasksPage): TwoViewsState {
  return go(state, { mainView: 'tasks', tasksPage: page });
}

function applyDestination(
  state: TwoViewsState,
  destination: TwoViewsDestination
): TwoViewsState {
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

function withTaskPage(
  state: TwoViewsState,
  patch: Partial<Extract<TasksPage, { kind: 'task' }>>
): TwoViewsState {
  const page = state.tasksPage;
  if (page.kind !== 'task') return state;
  return { ...state, tasksPage: { ...page, ...patch } };
}

// Where an address leads: people and outside agents peek, rooms and tasks open under Tasks.
function openAddress(state: TwoViewsState, address: string): TwoViewsState {
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
      return toTasks(state, {
        kind: 'task',
        taskId: rest,
        tab: 'auto',
        runId: null,
        full: false,
      });
    default:
      return state;
  }
}

function step(state: TwoViewsState, delta: -1 | 1): TwoViewsState {
  const index = state.historyIndex + delta;
  const entry = state.history[index];
  if (entry === undefined) return state;
  return {
    ...state,
    ...entry,
    historyIndex: index,
    peek: null,
    settings: null,
  };
}

export function twoViewsReducer(
  state: TwoViewsState,
  action: NavAction | TwoViewsAction
): TwoViewsState {
  switch (action.type) {
    case 'selectProject':
      return {
        ...initialTwoViewsState,
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
      // In Tasks the page opens beside the list; over Overseer it stays a peek.
      return state.mainView === 'tasks'
        ? toTasks(state, {
            kind: 'task',
            taskId: action.taskId,
            tab: 'auto',
            runId: null,
            full: false,
          })
        : { ...state, peek: { kind: 'task', taskId: action.taskId } };
    case 'closePeek':
    case 'tv/closePeek':
      return state.peek === null ? state : { ...state, peek: null };
    case 'openRun':
      return withTaskPage(state, { runId: action.runId });
    case 'openTask':
      return toTasks(state, {
        kind: 'task',
        taskId: action.taskId,
        tab: action.tab ?? 'auto',
        runId: action.runId ?? null,
        full: true,
      });
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
    case 'openImpact':
      return toTasks(state, { kind: 'impact', subject: action.subject });
    case 'back':
      if (state.peek !== null) return { ...state, peek: null };
      return step(state, -1);
    case 'forward':
      return step(state, 1);
    case 'escape':
      if (state.settings !== null) return { ...state, settings: null };
      if (state.peek !== null) return { ...state, peek: null };
      if (state.mainView === 'tasks' && state.tasksPage.kind !== 'list') {
        return toTasks(state, LIST);
      }
      return state;
    case 'tv/showOverseer':
      return applyDestination(state, { kind: 'overseer' });
    case 'tv/showTasks':
      return action.preset === undefined
        ? {
            ...go(state, { mainView: 'tasks', tasksPage: state.tasksPage }),
            tasksPreset: 'all',
          }
        : { ...toTasks(state, LIST), tasksPreset: action.preset };
    case 'tv/setTasksPreset':
      return { ...state, tasksPreset: action.preset };
    case 'tv/setTasksMode':
      return { ...state, tasksMode: action.mode };
    case 'tv/openSettings':
      return { ...state, settings: action.page ?? 'general' };
    case 'tv/closeSettings':
      return state.settings === null ? state : { ...state, settings: null };
    case 'tv/closePage':
      return toTasks(state, LIST);
    case 'tv/expandTask':
      return withTaskPage(state, { full: true });
    case 'tv/openAddress':
      return openAddress(state, action.address);
    case 'closeRun':
    case 'openNewTask':
    case 'closeNewTask':
    case 'openPalette':
    case 'closePalette':
    case 'togglePalette':
    case 'openShortcuts':
    case 'closeShortcuts':
      return state;
    default: {
      const unhandled: never = action;
      return unhandled;
    }
  }
}

/** Both layouts' navigation, moved by one dispatch so either can render at any time. */
export interface AppNavState {
  nav: NavState;
  twoViews: TwoViewsState;
}

export const initialAppNavState: AppNavState = {
  nav: initialNavState,
  twoViews: initialTwoViewsState,
};

function isTwoViewsAction(
  action: NavAction | TwoViewsAction
): action is TwoViewsAction {
  return action.type.startsWith('tv/');
}

export function appNavReducer(
  state: AppNavState,
  action: NavAction | TwoViewsAction
): AppNavState {
  const nav = isTwoViewsAction(action)
    ? state.nav
    : navReducer(state.nav, action);
  const twoViews = twoViewsReducer(state.twoViews, action);
  return nav === state.nav && twoViews === state.twoViews
    ? state
    : { nav, twoViews };
}
