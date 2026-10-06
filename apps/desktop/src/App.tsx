import type { TaskListItem } from '@dispatch-foo/core/browser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Coins, Plus, TriangleAlert, Wrench } from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';

import { AwayDigest, useNarratorSince } from './components/chat/AwayDigest';
import { ForYouPosts } from './components/chat/ForYouPosts';
import { TasksComposer } from './components/chat/TasksComposer';
import { ConversationTimeline } from './components/conversation/ConversationTimeline';
import {
  RoomHome,
  TaskConversationHome,
} from './components/conversation/Homes';
import {
  type FlightPlanHost,
  FlightPlanHostContext,
} from './components/flightplan/ContainerFlightPlanSection';
import { MemoryRecent } from './components/memory/MemoryRecent';
import { OutsidePeek } from './components/peek/OutsidePeek';
import { PersonPeek } from './components/peek/PersonPeek';
import { ThreadPeek } from './components/peek/ThreadPeek';
import { PeopleProvider } from './components/people/PeopleContext';
import { accessFor } from './components/settings/access';
import { OverseerGrantsGroup } from './components/settings/OverseerGrantsGroup';
import { AddProjectDialog } from './components/shell/AddProjectDialog';
import { CommandPalette } from './components/shell/CommandPalette';
import { DaemonUnavailable } from './components/shell/DaemonUnavailable';
import {
  DeepLinkProvider,
  useCopyTaskLink,
} from './components/shell/DeepLinkContext';
import { ErrorBoundary } from './components/shell/ErrorBoundary';
import { FrameStatusStrip } from './components/shell/FrameStatusStrip';
import { LiveRail } from './components/shell/LiveRail';
import {
  type NotificationInbox,
  NotificationInboxProvider,
} from './components/shell/NotificationInboxContext';
import { PresenceStack } from './components/shell/PresenceStack';
import { ProjectSwitcher } from './components/shell/ProjectSwitcher';
import { QuickCaptureDialog } from './components/shell/QuickCaptureDialog';
import { SavedViewsProvider } from './components/shell/SavedViewsContext';
import { SettingsPanel } from './components/shell/SettingsPanel';
import {
  type CreateTaskPreset,
  type ShellActions,
  ShellActionsProvider,
} from './components/shell/ShellActionsContext';
import { ShortcutsDialog } from './components/shell/ShortcutsDialog';
import {
  PROJECT_NAV_VIEWS,
  PROJECT_VIEW_ORDER,
  Sidebar,
  useSidebarCollapsed,
  useTrafficLightInset,
} from './components/shell/Sidebar';
import {
  taskToastDescription,
  viewTaskLink,
} from './components/shell/toastContract';
import { useToasts } from './components/shell/Toasts';
import { TwoViewShell } from './components/shell/TwoViewShell';
import { AiTaskComposer } from './components/tasks/AiTaskComposer';
import { CreateTaskModal } from './components/tasks/CreateTaskModal';
import { NeedsYouBlock } from './components/tasks/NeedsYouBlock';
import { TaskPage } from './components/tasks/page/TaskPage';
import {
  type TaskPageHost,
  TaskPageHostContext,
} from './components/tasks/page/TaskPageHost';
import { TaskPeekDialog } from './components/tasks/TaskPeekDialog';
import { TasksBackButton } from './components/tasks/TasksPageHeader';
import { TaskThreadTab } from './components/tasks/TaskThreadTab';
import { useAdminItems } from './hooks/useAdminItems';
import { useDataChangedEvents } from './hooks/useDataChangedEvents';
import { useDeepLinkRouter } from './hooks/useDeepLinkRouter';
import { useDispatchProject } from './hooks/useDispatchProject';
import { useDocList } from './hooks/useDocs';
import { useGlobalKeyboard } from './hooks/useGlobalKeyboard';
import { useOverseerSession } from './hooks/useOverseerSession';
import { useSavedViews } from './hooks/useSavedViews';
import {
  threadListsKey,
  useA2APeers,
  useChannels,
  useMailbox,
  useThreadsNeedsYouCount,
} from './hooks/useThreads';
import {
  type ActionFeedbackCache,
  withActionFeedback,
} from './lib/actionFeedback';
import { orbLabel, orbState, overseerTurnLive } from './lib/agentPresence';
import { overseerOf } from './lib/agentRoster';
import type {
  GlobalView,
  ProjectView,
  SettingsPage,
  TaskTab,
} from './lib/appNav';
import { hideArchivedRuns } from './lib/archiveFilter';
import { twoViewsAllowed, useBetaFlag } from './lib/betaFeatures';
import { hasDispatchKey, launchRootKey } from './lib/bootWarm';
import { mentions, subjectOf } from './lib/conversationScope';
import { type DecisionItem, decisionTarget } from './lib/decisionFeed';
import type { InboxTarget } from './lib/inbox';
import { projectViewForInboxTarget, unreadCount } from './lib/inbox';
import { buildInbox } from './lib/inboxQueue';
import type { GlobalKeyCommand } from './lib/keyboard';
import { liveCeilingsOf, spendToday } from './lib/liveSpend';
import { awayDigest } from './lib/narrator';
import { needsYou } from './lib/needsYou';
import type { OverseerDoor } from './lib/overseerThread';
import {
  addressEntries,
  buildPaletteEntries,
  docHitEntries,
} from './lib/paletteEntries';
import { PALETTE_SECTION_CAPS } from './lib/paletteSections';
import { buildPosts, type Post } from './lib/posts';
import { basename } from './lib/projectName';
import { prNumberFromUrl } from './lib/reviewTarget';
import { isTerminalRunState } from './lib/runState';
import { useStatusModelOf } from './lib/statusModel';
import { computeBlockedIds } from './lib/taskGraph';
import { itemBucket, queuedTaskIds, taskStatusCounts } from './lib/taskStatus';
import { useTasksViewMode } from './lib/tasksViewMode';
import {
  addProject,
  currentProjectRoot,
  hasDispatch,
  listProjects,
  listRegisteredProjects,
  touchProjectOpened,
} from './lib/tauri';
import {
  isTeamLocalPage,
  readTeamSession,
  signOutOfTeam,
} from './lib/teamLocal';
import { openRefWith, type RefAction } from './lib/threadSources';
import {
  appNavReducer,
  type HostedView,
  initialAppNavState,
} from './lib/twoViews';
import { checkForUpdate, installUpdateAndRelaunch } from './lib/updater';
import { applyZoomFactor, loadZoomFactor, stepZoomFactor } from './lib/zoom';
import { AllAgentsView } from './views/AllAgentsView';
import { BoardView } from './views/BoardView';
import { BrainDumpView } from './views/BrainDumpView';
import { BranchesView } from './views/BranchesView';
import { CockpitView } from './views/CockpitView';
import { DesignView } from './views/DesignView';
import { DocsView } from './views/DocsView';
import { DraftView } from './views/DraftView';
import { FilesView } from './views/FilesView';
import { FirstRunView } from './views/FirstRunView';
import { GalleryView } from './views/GalleryView';
import { GetStartedView } from './views/GetStartedView';
import { ImpactView } from './views/ImpactView';
import { InboxView } from './views/InboxView';
import { LandingTableView } from './views/LandingTableView';
import { LiveView } from './views/LiveView';
import type { FocusEpicRequest } from './views/MilestonesView';
import { OverseerFocusView } from './views/OverseerFocusView';
import { OverseerView } from './views/OverseerView';
import { OverviewView } from './views/OverviewView';
import { PlansView } from './views/PlansView';
import { ProjectsView } from './views/ProjectsView';
import { PrReviewView } from './views/PrReviewView';
import { SessionsHubView } from './views/SessionsHubView';
import { type HostedSettingsPage, SettingsView } from './views/SettingsView';
import { type TasksSidePage, TasksView } from './views/TasksView';
import { TerminalsView } from './views/TerminalsView';
import { ThreadsView } from './views/ThreadsView';
import { type OverseerFocus, TwoViewOverseer } from './views/TwoViewOverseer';
import { cn } from '@/lib/utils';
import { PageHeaderShellContext } from '@/ui/ai/page-header';
import { Button } from '@/ui/button';
import { EmptyState, SectionLabel } from '@/ui/chrome';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/ui/empty';
import { SidebarProvider } from '@/ui/sidebar';
import { Spinner } from '@/ui/spinner';
import { TooltipProvider } from '@/ui/tooltip';

// The hosts a task page and a Flight Plan draw from, provided together so the shell's
// provider stack stays one level deep.
// The Inbox's doc query: team docs whose head is conflicted or that carry a
// Linear sync problem.
const CONFLICTED_TEAM_DOCS = { conflicted: true, scope: 'team' } as const;

function SurfaceHosts({
  taskPage,
  flightPlan,
  children,
}: {
  taskPage: TaskPageHost | null;
  flightPlan: FlightPlanHost;
  children: ReactNode;
}) {
  return (
    <TaskPageHostContext.Provider value={taskPage}>
      <FlightPlanHostContext.Provider value={flightPlan}>
        {children}
      </FlightPlanHostContext.Provider>
    </TaskPageHostContext.Provider>
  );
}

// Two views has no sidebar to toggle and owns its own drag region.
const TWO_VIEWS_PAGE_HEADER = {
  sidebarHidden: false,
  onToggleSidebar: () => {},
  trafficLightInset: false,
  dragRegion: false,
};

function App() {
  const queryClient = useQueryClient();
  // Classic and Two views move together on every action, so either layout can render.
  const [{ nav: navState, twoViews: twoViewsState }, dispatchNav] = useReducer(
    appNavReducer,
    initialAppNavState
  );
  const [showCreate, setShowCreate] = useState(false);
  // What a board column's or list group's "+" pre-fills into the creator (status today;
  // epic/milestone once the creator reads them); `null` leaves every field to its default.
  const [createPreset, setCreatePreset] = useState<CreateTaskPreset | null>(
    null
  );
  // The AI task composer, a dialog rather than a screen — open state lives here (not in
  // `navState`) so it renders on top of whatever view is underneath instead of replacing it.
  const [aiComposerOpen, setAiComposerOpen] = useState(false);

  // Whether the rail is hidden (`[`), owned here because `SidebarProvider` wraps the whole
  // shell row. Persistence lives with the rail.
  const [sidebarCollapsed, setSidebarCollapsed] = useSidebarCollapsed();
  // Whether to clear the macOS traffic lights: the rail's top strip when it is showing, the
  // panel header (via `PageHeaderShellContext`) when it is hidden.
  const trafficLightInset = useTrafficLightInset();
  // The Tasks view's layout, kept at App level until the Tasks header's view tabs own it.
  const [tasksViewMode, setTasksViewMode] = useTasksViewMode();
  // A one-shot "go to this milestone" for the Tasks page's milestones layout — Plans'
  // confirm or the live rail's milestone row. `nonce` tells two requests for one epic
  // apart; cleared on leaving the board so a return visit does not replay it.
  const [focusEpic, setFocusEpic] = useState<FocusEpicRequest | null>(null);
  // Text handed to the planner from elsewhere (Brain dump's "hand it to the planner", or one
  // inbox item's "plan it"). Keyed into PlansView so a second hand-off with different text
  // remounts the composer rather than being swallowed by its existing state.
  const [planSeed, setPlanSeed] = useState<string | null>(null);

  const toasts = useToasts();

  // Auto-update: check GitHub's `latest.json` once after mount (non-blocking —
  // `checkForUpdate` is a no-op outside Tauri and swallows its own errors), and
  // if a newer signed release is published, offer it as a toast with a Restart
  // action. Dismissal is session-only; the next launch re-checks.
  useEffect(() => {
    void checkForUpdate().then((update) => {
      if (update === null) return;
      toasts.push({
        title: `Dispatch ${update.version} available`,
        description: 'Restart to update.',
        action: {
          label: 'Restart',
          onClick: () => {
            void installUpdateAndRelaunch(update).catch((err: unknown) => {
              toasts.push({
                title: 'Update failed',
                description: err instanceof Error ? err.message : String(err),
                tone: 'error',
              });
            });
          },
        },
      });
    });
  }, [toasts]);

  // Re-applies the persisted webview zoom on launch — ⌘+/⌘−/⌘0 adjust it from
  // `useGlobalKeyboard`'s command handler below.
  useEffect(() => {
    applyZoomFactor(loadZoomFactor());
  }, []);

  useDataChangedEvents();

  // Reaching `new-task` only opens the AI composer dialog and hands the view back to
  // `newTaskReturnView` — `useLayoutEffect` so this happens before paint, with no blank frame.
  useLayoutEffect(() => {
    if (navState.projectView !== 'new-task') return;
    setAiComposerOpen(true);
    dispatchNav({ type: 'closeNewTask' });
  }, [navState.projectView]);

  // The app is scoped to a single project — the one it was launched from (see
  // `commands::current_project_root`'s doc comment for the `tauri dev`-vs-packaged-app
  // resolution). This replaces the old `listProjects` + per-path `hasDispatch` fan-out, which
  // enumerated every project the app had ever seen (100+ on a real machine, many stale/deleted)
  // and ran a `Promise.all` over all of them: one slow/failing entry there took the *whole*
  // batch down, leaving every view stuck on `portLoading`'s "Loading" state forever, and even
  // when it didn't outright fail, it could just as easily resolve to an unrelated project
  // instead of the one this window is actually running in. `retry: false` on both queries
  // below so a real failure surfaces as an explicit error rather than another perpetual spinner.
  const {
    data: launchRoot,
    isError: rootError,
    error: rootErrorDetail,
  } = useQuery({
    queryKey: launchRootKey(),
    queryFn: currentProjectRoot,
    staleTime: Infinity,
    retry: false,
  });

  // The switcher lets you move this window to another dispatch-enabled project
  // without giving up the single-project focus — one project is active at a
  // time. `overrideRoot` (set by the sidebar dropdown) wins over the launch
  // project; `null` means "stay on the project this window launched in".
  const [overrideRoot, setOverrideRoot] = useState<string | null>(null);
  const root = overrideRoot ?? launchRoot;

  // The dropdown's project list is loaded lazily — only once the switcher is
  // opened — and with `allSettled` so a single stale/missing path can never
  // reject the batch. This is deliberately OFF the boot path: the app resolves
  // its launch project and renders immediately; discovering *other* projects is
  // a background nicety that must never be able to hang the app (the exact
  // failure mode the single-project pivot fixed).
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const { data: switchProjects } = useQuery({
    queryKey: ['switcher-projects'],
    queryFn: async () => {
      // Two sources, resolved together: the persistent registry (projects the user has
      // explicitly added/opened) and the watcher's discovered projects (dispatch-enabled paths it
      // already knows about). `allSettled` on the discovery side so a single stale/missing
      // path can never reject the batch.
      const [registered, discovered] = await Promise.all([
        listRegisteredProjects(),
        (async () => {
          const projects = await listProjects();
          const checks = await Promise.allSettled(
            projects.map(async (p) => ((await hasDispatch(p.path)) ? p : null))
          );
          return checks
            .filter(
              (
                r
              ): r is PromiseFulfilledResult<
                (typeof projects)[number] | null
              > => r.status === 'fulfilled'
            )
            .map((r) => r.value)
            .filter((p): p is (typeof projects)[number] => p !== null)
            .map((p) => ({ path: p.path, name: basename(p.path) }));
        })(),
      ]);

      // Registry entries first, then discovered ones, deduped by path so a project that's both
      // registered and discovered appears once (with its registry name).
      const merged: { path: string; name: string }[] = [];
      const seen = new Set<string>();
      for (const p of [
        ...registered.map((r) => ({ path: r.path, name: r.name })),
        ...discovered,
      ]) {
        if (seen.has(p.path)) continue;
        seen.add(p.path);
        merged.push(p);
      }
      return merged;
    },
    enabled: switcherOpen,
    staleTime: 30_000,
    retry: false,
  });

  const [addProjectOpen, setAddProjectOpen] = useState(false);

  const selectSwitchProject = useCallback((path: string) => {
    setOverrideRoot(path);
    setSwitcherOpen(false);
    // Stamp `lastOpenedAt` so this project becomes the registry's "most recent" — both for the
    // switcher's ordering and for `current_project_root`'s reopen-last chain on next launch.
    // Fire-and-forget: a registry write failure must not block switching the window.
    void touchProjectOpened(path);
    // Drop the current project's nav context so the new project opens clean on
    // its Board rather than inheriting a peek/run id from the previous one.
    dispatchNav({ type: 'selectProject', projectId: path });
  }, []);

  // Registers the folder/repo the add-project dialog produced, then switches the window to the
  // normalized path the backend stored (which `addProject` returns). Rethrows so the dialog can
  // surface a validation error (e.g. the path isn't a directory) instead of silently closing.
  const handleAddProject = useCallback(
    async (path: string) => {
      const normalized = await addProject(path);
      setAddProjectOpen(false);
      selectSwitchProject(normalized);
    },
    [selectSwitchProject]
  );

  const {
    data: rootHasDispatch,
    isError: hasDispatchError,
    error: hasDispatchErrorDetail,
  } = useQuery({
    queryKey: hasDispatchKey(root),
    queryFn: () => {
      // `root` is only a string here — `enabled` below excludes `undefined` (still
      // resolving) and `null` (first run, no project yet, see `currentProjectRoot`).
      if (root === undefined || root === null) {
        throw new Error('project root not resolved');
      }
      return hasDispatch(root);
    },
    enabled: root !== undefined && root !== null,
    staleTime: Infinity,
    retry: false,
  });

  const activeProject = useMemo(
    () =>
      root !== undefined && root !== null && rootHasDispatch === true
        ? { path: root, name: basename(root) }
        : null,
    [root, rootHasDispatch]
  );

  // Mirrors the previous "restore last active project" effect's one real job now that there
  // is only ever one project to select: moves `navReducer` into its `project` section (default
  // Board view, no stale peek/run) the moment this window's project resolves as
  // dispatch-enabled. `projectId` here is just `navState`'s existing "is a project active"
  // marker, not a switcher target — see `Sidebar`'s `hasActiveProject` prop for how it's read.
  useEffect(() => {
    if (activeProject === null || navState.activeProjectId !== null) return;
    dispatchNav({ type: 'selectProject', projectId: activeProject.path });
  }, [activeProject, navState.activeProjectId]);

  const selectProjectView = useCallback((view: ProjectView) => {
    dispatchNav({ type: 'setProjectView', view });
  }, []);

  // `page` lands Settings on one of its pages — the rail's Connect Linear and the strip's
  // gear ask for Integrations; `g s` and the switcher's gear leave it to the last page.
  const setGlobalView = useCallback(
    (view: GlobalView, options?: { page?: SettingsPage }) => {
      dispatchNav({ type: 'setGlobalView', view, page: options?.page });
    },
    []
  );

  // Opens the Tasks page on its milestones layout, focused on one epic; `dispatch` also
  // opens the fan-out dialog there (Plans' "Create & send agents…").
  const openMilestone = useCallback(
    (epicId: string, { dispatch = false }: { dispatch?: boolean } = {}) => {
      setTasksViewMode('milestones');
      setFocusEpic({ epicId, dispatch, nonce: Date.now() });
      selectProjectView('board');
    },
    [setTasksViewMode, selectProjectView]
  );

  useEffect(() => {
    if (navState.projectView !== 'board') setFocusEpic(null);
  }, [navState.projectView]);

  // Opens the task creator, optionally pre-filled — the single entry point every "New
  // task"/"+" affordance (the rail's pencil, a board column's or list group's hover "+", the
  // palette action, the global `c` shortcut) calls through, so the creator's preset is
  // always explicit rather than a leftover from whichever column's "+" was clicked last.
  // Describing the task in natural language is the primary path; the structured modal
  // below is the quick-add fallback.
  const openCreateTask = useCallback((preset?: CreateTaskPreset) => {
    setCreatePreset(preset ?? null);
    // The AI composer drafts issues only; a project or milestone opens the form.
    if (preset?.kind !== undefined && preset.kind !== 'task') {
      setShowCreate(true);
      return;
    }
    dispatchNav({ type: 'openNewTask' });
  }, []);

  const closeCreateTask = useCallback(() => {
    setAiComposerOpen(false);
    setShowCreate(false);
    dispatchNav({ type: 'closeNewTask' });
  }, []);

  // The structured quick-add fallback: `CreateTaskModal`, unchanged, for when you already know
  // the exact fields and don't want to spend an agent round-trip describing them. Reachable
  // from the palette and from the full-page creator's own "Quick add…" button.
  const openQuickAddTask = useCallback((preset?: CreateTaskPreset) => {
    setCreatePreset(preset ?? null);
    setShowCreate(true);
  }, []);

  // Moves nav state to the newly (re-)dispatched run. The task view is the only run surface
  // now, and a run that has just been created is live, so it opens on Run.
  // Two views' page right now; read by callbacks made before it is computed below.
  const twoViewsPageRef = useRef<{ on: boolean; taskId: string | null }>({
    on: false,
    taskId: null,
  });
  const onRunDispatched = useCallback((runId: string, taskId: string) => {
    // A run started from a task already open (split or full) stays on that page.
    const page = twoViewsPageRef.current;
    if (page.on && page.taskId === taskId) {
      dispatchNav({ type: 'setTaskTab', tab: 'run' });
      dispatchNav({ type: 'openRun', runId });
      return;
    }
    dispatchNav({ type: 'openTask', taskId, tab: 'run', runId });
  }, []);

  const rawData = useDispatchProject(activeProject?.path ?? null, {
    selectedRunId: navState.activeRunId,
    onRunDispatched,
  });

  const [twoViewsOn, setTwoViewsOn] = useBetaFlag('two-views');
  const twoViews =
    twoViewsOn &&
    twoViewsAllowed({ teamLocal: isTeamLocalPage(), tier: rawData.myTier });
  // Settings or a peek opened under Classic must not pop up when Two views turns on.
  useEffect(() => {
    dispatchNav({ type: 'tv/closeSettings' });
    dispatchNav({ type: 'tv/closePeek' });
  }, [twoViews]);

  // Only a teammate on a team-local page has a session to end. Read once:
  // signing in and out both reload the page.
  const teamSession = useMemo(() => {
    const session = isTeamLocalPage() ? readTeamSession() : null;
    return session === null
      ? undefined
      : { handle: session.handle, onSignOut: () => void signOutOfTeam() };
  }, []);

  // Tells whoever else is on this daemon which task this window has open —
  // the full view or the peek, whichever is showing. Best effort: a failed
  // report costs a teammate one stale "viewing", never an error here.
  const twoViewsTaskId =
    twoViewsState.tasksPage.kind === 'task'
      ? twoViewsState.tasksPage.taskId
      : twoViewsState.peek?.kind === 'task'
        ? twoViewsState.peek.taskId
        : null;
  const twoViewsOpenTaskId =
    twoViews &&
    twoViewsState.mainView === 'tasks' &&
    twoViewsState.tasksPage.kind === 'task'
      ? twoViewsState.tasksPage.taskId
      : null;
  useEffect(() => {
    twoViewsPageRef.current = {
      on: twoViewsOpenTaskId !== null,
      taskId: twoViewsOpenTaskId,
    };
  }, [twoViewsOpenTaskId]);
  const focusedTaskId = twoViews
    ? twoViewsTaskId
    : (navState.activeTaskId ?? navState.peekTaskId);
  const presenceClient = rawData.client;
  useEffect(() => {
    if (presenceClient === null) return;
    presenceClient.setPresenceFocus(focusedTaskId).catch(() => {});
  }, [presenceClient, focusedTaskId]);

  // Wrapped once, here, so a failed action says so instead of the button
  // appearing to do nothing. See lib/actionFeedback.ts for why this is not done
  // per handler.
  // The toasts read the latest project through a ref, so the callbacks (and the
  // wrapper cache keyed on them) survive task changes and unchanged handlers keep
  // their identity — memo'd rows then skip re-rendering.
  const rawDataRef = useRef(rawData);
  useEffect(() => {
    rawDataRef.current = rawData;
  }, [rawData]);
  const feedback = useMemo(
    () => ({
      onError: (action: string, message: string) =>
        toasts.push({
          title: `${action} failed`,
          description: message,
          tone: 'error',
        }),
      onSuccess: (message: string, taskId?: string) =>
        toasts.push({
          title: message,
          tone: 'success',
          ...(taskId !== undefined && {
            description: taskToastDescription(
              taskId,
              rawDataRef.current.tasks.find((t) => t.meta.id === taskId)?.meta
                .title ?? taskId
            ),
            link: viewTaskLink(taskId, (id) =>
              dispatchNav({
                type: 'openTask',
                taskId: id,
                tab: 'auto',
                runId: rawDataRef.current.latestRunByTaskId.get(id)?.id ?? null,
              })
            ),
          }),
        }),
      cache: new WeakMap() as ActionFeedbackCache,
    }),
    [toasts]
  );
  const data = useMemo(
    () =>
      withActionFeedback(
        rawData,
        feedback.onError,
        feedback.onSuccess,
        feedback.cache
      ),
    [rawData, feedback]
  );
  // Settings reports its own save failures (its save line, a refusal's reason,
  // a kept draft), which the toast wrapper above would swallow first.
  const settingsData = useMemo(
    () => ({ ...data, handleUpdateConfig: rawData.handleUpdateConfig }),
    [data, rawData.handleUpdateConfig]
  );

  // The overseer chat's session — mounted here, not inside OverseerView, so the
  // open conversation survives switching tabs. Uses `rawData`'s client/port
  // directly (its errors surface in the view's own transcript rows, not as
  // action-feedback toasts); useDispatchProject's WS handler invalidates its
  // record query on `overseer.changed`.
  const overseer = useOverseerSession(
    rawData.client,
    rawData.port,
    activeProject?.path ?? null,
    rawData.config?.models.overseer,
    rawData.config?.effort?.overseer,
    twoViews
  );

  // Opens the full task view; unspecified runId resolves to the task's latest
  // run so Run/Review have something to show immediately. With no mode named the
  // page follows the task's state: a container opens on its Flight Plan.
  const openTaskView = useCallback(
    (taskId: string, tab: TaskTab = 'auto', runId?: string) => {
      const resolved =
        runId ?? rawData.latestRunByTaskId.get(taskId)?.id ?? null;
      dispatchNav({ type: 'openTask', taskId, tab, runId: resolved });
    },
    [rawData.latestRunByTaskId]
  );

  // A Tasks-page row or card open: a phase drill from the milestones layout names
  // its tab; a plain click keeps the peek. Stable, so memo'd rows can skip renders.
  const selectBoardTask = useCallback(
    (taskId: string, tab?: TaskTab, runId?: string) => {
      if (tab !== undefined) openTaskView(taskId, tab, runId);
      else dispatchNav({ type: 'openPeek', taskId });
    },
    [openTaskView]
  );

  // The Docs view on one doc, scrolled to `anchor`'s section when set.
  const openDoc = useCallback(
    (docId: string, anchor: string | null, merge?: string) =>
      dispatchNav({ type: 'openDoc', docId, anchor, merge }),
    []
  );

  // Where a ref chip or a sender name in a thread leads.
  const openRef = useMemo(
    () =>
      openRefWith({
        openTask: (taskId, tab, runId) => openTaskView(taskId, tab, runId),
        openThread: (messageId) =>
          dispatchNav({ type: 'openThread', messageId }),
        openImpact: (subject) => dispatchNav({ type: 'openImpact', subject }),
        openDoc,
      }),
    [openTaskView, openDoc]
  );
  const openThread = useCallback(
    (messageId: string | null) =>
      dispatchNav({ type: 'openThread', messageId }),
    []
  );

  // The sidebar's Threads count, from queries the Threads view shares.
  const threadsNeedsYou = useThreadsNeedsYouCount(
    rawData.client,
    rawData.port,
    rawData.me,
    rawData.messageAccess
  );

  // The project's saved views and favorites, one instance shared through
  // `SavedViewsProvider` by the Tasks header's tabs, the task page's star and the rail.
  const savedViews = useSavedViews(activeProject?.path ?? null);

  // `Copy link` for the task page, the row menu and the palette; the router turns a
  // received `dispatch://task/…` link (or the harness's `?task=`) into "switch project if
  // needed, then open the task once its tasks have loaded".
  const copyTaskLink = useCopyTaskLink(activeProject?.path ?? null);
  const deepLinkActions = useMemo(() => ({ copyTaskLink }), [copyTaskLink]);
  useDeepLinkRouter({
    activeProjectPath: activeProject?.path ?? null,
    tasksReady: data.tasksReady,
    hasTask: (id) => data.tasksIncludingArchived.some((t) => t.meta.id === id),
    hasDispatch,
    switchProject: selectSwitchProject,
    openTask: (id) => openTaskView(id),
    notify: toasts.push,
  });

  // One run row (All agents, the merge queue) opens its task on the tab that matches what you
  // can do with the run: a finished one's diff, a live one's transcript.
  const jumpToRun = useCallback(
    (runId: string) => {
      const run = rawData.runs.find((r) => r.id === runId);
      if (run === undefined) return;
      openTaskView(
        run.taskId,
        isTerminalRunState(run.state) ? 'review' : 'run',
        run.id
      );
    },
    [rawData.runs, openTaskView]
  );

  // Every non-terminal run for this project — the "Agents" view's list and the sidebar's live
  // badge both read from this single project's own run list now, not a cross-project fan-out
  // of N daemons (the old `useAllAgents`, removed with this pivot).
  // Everything spent today across this project's runs; `null` hides the readout.
  const todaySpend = useMemo(() => spendToday(data.runs), [data.runs]);

  const liveRuns = useMemo(
    () => data.runs.filter((run) => !isTerminalRunState(run.state)),
    [data.runs]
  );

  // The live fan-outs summed for the status strip: settled spend across them and their
  // spend ceilings added up — `null` ceilings when no live session set one.
  const liveCeilings = useMemo(
    () => liveCeilingsOf(data.liveEpicSessions),
    [data.liveEpicSessions]
  );

  // How many runs the archive filter is holding back, computed off the *unfiltered* list so
  // the All-agents toggle can still say what turning it on would reveal while it is already
  // on (`visibleRuns` is the full list in that case, and would report zero).
  const archivedRunCount = useMemo(() => {
    const archivedTaskIds = new Set(data.archivedTasks.map((t) => t.meta.id));
    return (
      data.runs.length - hideArchivedRuns(data.runs, archivedTaskIds).length
    );
  }, [data.runs, data.archivedTasks]);

  // Everything the Inbox view shows — the Control room feed's urgent tiers, one row per
  // task. See `buildInbox`; this one result also feeds the sidebar badge and the rail's
  // attention strip, so the three surfaces always agree.
  const statusModel = useStatusModelOf(data.config);
  // Conflicted team docs are Inbox items until a save clears them.
  const conflictedDocs = useDocList(
    data.messageAccess.canMessage ? data.client : null,
    data.port,
    CONFLICTED_TEAM_DOCS
  ).docs;
  const inboxData = useMemo(
    () =>
      buildInbox({
        runs: data.runs,
        tasks: data.tasks,
        epics: data.epics,
        repoPrs: data.repoPrs ?? [],
        mergeQueue: data.mergeQueue,
        pendingApprovals: data.pendingApprovals,
        openQuestions: data.openQuestions,
        openScopeRequests: data.pendingScopeRequests,
        fixLoops: data.fixLoops,
        me: data.me,
        asksMe: data.asksMe,
        model: statusModel,
        conflictedDocs,
      }),
    [
      conflictedDocs,
      data.runs,
      data.tasks,
      data.epics,
      data.repoPrs,
      data.me,
      data.asksMe,
      data.mergeQueue,
      data.pendingApprovals,
      data.openQuestions,
      data.pendingScopeRequests,
      data.fixLoops,
      statusModel,
    ]
  );

  // One set of numbers: the orb, "tasks ●" and the Needs you header all read `needs.count`.
  const mailbox = useMailbox(
    data.client,
    data.port,
    data.me,
    twoViews && data.messageAccess.canMessage
  ).data?.items;
  // My tasks: assigned to me, or their latest run is mine.
  const myTaskIds = useMemo(() => {
    const mine = new Set<string>();
    if (data.me === null) return mine;
    for (const doc of data.tasks) {
      const run = data.latestRunByTaskId.get(doc.meta.id);
      if (
        doc.meta.assignee === data.me ||
        (run?.operator ?? run?.dispatchedBy) === data.me
      ) {
        mine.add(doc.meta.id);
      }
    }
    return mine;
  }, [data.tasks, data.latestRunByTaskId, data.me]);
  const needs = useMemo(
    () => needsYou(data.decisions, data.me, { mailbox, myTaskIds }),
    [data.decisions, data.me, mailbox, myTaskIds]
  );
  // The narrator: what settled since the human last dismissed it, no model involved.
  const narrator = useNarratorSince(
    twoViews ? (activeProject?.path ?? null) : null
  );
  const digest = useMemo(
    () =>
      awayDigest({
        since: narrator.since,
        runs: data.runs,
        merges: data.mergeQueue?.history ?? [],
      }),
    [narrator.since, data.runs, data.mergeQueue]
  );
  // Asks of mine decided in the last 15 minutes, for "Decided by you" receipts.
  const recentlyDecided = useMemo(() => {
    const since = Date.now() - 15 * 60_000;
    return data.decisions.filter(
      (item) =>
        item.state === 'resolved' &&
        item.resolvedAt !== undefined &&
        Date.parse(item.resolvedAt) >= since &&
        (item.owner === undefined || item.owner === data.me)
    );
  }, [data.decisions, data.me]);
  const blockedIds = useMemo(
    () => computeBlockedIds(data.tasks, statusModel),
    [data.tasks, statusModel]
  );
  const statusCounts = useMemo(
    () =>
      taskStatusCounts(data.tasks, {
        asking: needs.taskIds,
        attention: data.attentionByTaskId,
        latestRun: data.latestRunByTaskId,
        queued: queuedTaskIds(data.mergeQueue),
        blocked: blockedIds,
        model: statusModel,
      }),
    [
      data.tasks,
      needs.taskIds,
      data.attentionByTaskId,
      data.latestRunByTaskId,
      data.mergeQueue,
      blockedIds,
      statusModel,
    ]
  );
  const bucketOf = useCallback(
    (doc: TaskListItem) =>
      itemBucket(doc, {
        asking: needs.taskIds,
        attention: data.attentionByTaskId,
        latestRun: data.latestRunByTaskId,
        queued: queuedTaskIds(data.mergeQueue),
        blocked: blockedIds,
        model: statusModel,
      }),
    [
      needs.taskIds,
      data.attentionByTaskId,
      data.latestRunByTaskId,
      data.mergeQueue,
      blockedIds,
      statusModel,
    ]
  );
  const starredTaskIds = useMemo(
    () =>
      new Set(
        savedViews.favorites.flatMap((ref) =>
          ref.kind === 'task' ? [ref.id] : []
        )
      ),
    [savedViews.favorites]
  );
  const presetContext = useMemo(
    () => ({ bucketOf, starred: starredTaskIds }),
    [bucketOf, starredTaskIds]
  );
  const admin = useAdminItems(data.client, data.port, twoViews);
  const daemonDown = data.portLoading || data.portError || data.client === null;
  const orb = orbState({
    revoked: overseer.revoked,
    broken: daemonDown || overseer.record?.state === 'failed',
    asks: needs.count,
    review: statusCounts.buckets.review,
    turnLive: overseerTurnLive(overseer),
    liveRuns: liveRuns.length,
  });
  const orbTitle = orbLabel({
    state: orb,
    groups: Object.fromEntries(
      needs.groups.map((g) => [g.group, g.items.length])
    ),
    review: statusCounts.buckets.review,
  });

  // Whether a quick capture can land right now: the raw capture handler silently no-ops
  // without a daemon client, and a capture that quietly drops the thought is worse than no
  // dialog. Gates ⌘D and the rail's "Drop a thought" alike.
  const quickCaptureAvailable = activeProject !== null && data.client !== null;
  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false);
  const openQuickCapture = useCallback(() => {
    if (quickCaptureAvailable) setQuickCaptureOpen(true);
  }, [quickCaptureAvailable]);

  const toggleSidebar = useCallback(
    () => setSidebarCollapsed(!sidebarCollapsed),
    [sidebarCollapsed, setSidebarCollapsed]
  );

  const openShortcuts = useCallback(
    () => dispatchNav({ type: 'openShortcuts' }),
    []
  );

  // Two views' own meaning for a global key; true when it handled the command.
  const twoViewsCommand = (command: GlobalKeyCommand): boolean => {
    switch (command) {
      case 'goto-1':
      case 'goto-overseer':
        dispatchNav({ type: 'tv/showOverseer' });
        return true;
      case 'goto-2':
      case 'goto-tasks':
        dispatchNav({ type: 'tv/showTasks' });
        return true;
      case 'goto-settings':
        dispatchNav({ type: 'tv/openSettings' });
        return true;
      // There is no sidebar and no third view.
      case 'toggle-sidebar':
      case 'goto-3':
      case 'goto-4':
      case 'goto-5':
      case 'goto-6':
      case 'goto-7':
      case 'goto-8':
      case 'goto-9':
        return true;
      default:
        return false;
    }
  };

  useGlobalKeyboard({
    // `modalOpen` is computed inside the hook itself, via a live DOM check for any open
    // dialog — so SessionDetailModal/DiffModal mounted deep inside the Sessions hub also
    // suppress the global commands while open, the same as CreateTaskModal always did.
    onCommand: (command) => {
      if (twoViews && twoViewsCommand(command)) return;
      if (command === 'open-palette') dispatchNav({ type: 'togglePalette' });
      else if (command === 'escape') dispatchNav({ type: 'escape' });
      else if (command === 'nav-back') dispatchNav({ type: 'back' });
      else if (command === 'nav-forward') dispatchNav({ type: 'forward' });
      else if (
        command === 'zoom-in' ||
        command === 'zoom-out' ||
        command === 'zoom-reset'
      ) {
        applyZoomFactor(
          stepZoomFactor(
            loadZoomFactor(),
            command.slice(5) as 'in' | 'out' | 'reset'
          )
        );
      } else if (command === 'brain-dump') openQuickCapture();
      else if (command === 'toggle-sidebar') toggleSidebar();
      else if (command === 'new-task') {
        if (activeProject !== null) openCreateTask();
      } else if (command === 'open-shortcuts') openShortcuts();
      else if (command === 'goto-settings') setGlobalView('settings');
      else if (command === 'goto-overseer') setGlobalView('overseer');
      else if (command === 'goto-home') selectProjectView('cockpit');
      else if (command === 'goto-inbox') selectProjectView('inbox');
      else if (command === 'goto-threads') selectProjectView('threads');
      else if (command === 'goto-tasks') selectProjectView('board');
      else if (command === 'goto-projects') selectProjectView('projects');
      else if (command === 'goto-live') selectProjectView('live');
      else if (command === 'goto-control-room') selectProjectView('overview');
      else if (command.startsWith('goto-')) {
        // Position in the rail, not an id — ⌘1 is the first row, and so on.
        const view = PROJECT_VIEW_ORDER[Number(command.slice(5)) - 1];
        if (view !== undefined) selectProjectView(view);
      }
    },
  });

  // What every task page — the Cockpit's split pane, the peek, the full page — draws a
  // task with: the project and where its links go. Absent until the config has loaded.
  const rawHandleDispatch = rawData.handleDispatch;
  const projectRuns = data.runs;
  const taskPageHost: TaskPageHost | null =
    data.config === null
      ? null
      : {
          projectName: activeProject?.name ?? null,
          project: data,
          peekTask: (taskId) => dispatchNav({ type: 'openPeek', taskId }),
          openTaskPage: (taskId, mode, runId) =>
            openTaskView(taskId, mode, runId),
          // Raw, so a refusal reaches the page (which reports it) instead of resolving.
          dispatchTask: (taskId, executor, model, stayInPlace, effort) =>
            rawHandleDispatch(taskId, executor, model, {
              batch: stayInPlace,
              effort,
            }),
          openPr: (runId) => {
            const number = prNumberFromUrl(
              projectRuns.find((r) => r.id === runId)?.prUrl
            );
            if (number !== null) dispatchNav({ type: 'openPr', number });
          },
          openImpact: (subject) => dispatchNav({ type: 'openImpact', subject }),
          // Docs need a teammate or app token, as the Docs view does.
          openDoc: data.messageAccess.canMessage ? openDoc : undefined,
          // Threads need the same token; without it the page shows no Thread tab.
          threadView: !data.messageAccess.canMessage
            ? undefined
            : twoViews
              ? (taskId) => (
                  <TaskConversationHome
                    data={data}
                    taskId={taskId}
                    onOpenRef={openRef}
                  />
                )
              : (taskId) => (
                  <TaskThreadTab
                    data={data}
                    taskId={taskId}
                    onOpenRef={openRef}
                    onOpenOverseer={() => setGlobalView('overseer')}
                  />
                ),
          // Two views moves the repo-wide Files and Terminals onto each run's page.
          ...(twoViews && {
            showLessons: true,
            planOpensPages: true,
            compactPage: true,
            filesView: (runId: string) => (
              <FilesView data={data} runId={runId} />
            ),
            terminalView: (runId: string) => (
              <TerminalsView data={data} runId={runId} />
            ),
            prView: (runId: string, onClose: () => void) => {
              const number = prNumberFromUrl(
                projectRuns.find((r) => r.id === runId)?.prUrl
              );
              return number === null ? null : (
                <PrReviewView
                  key={number}
                  projectName={activeProject?.name ?? null}
                  data={data}
                  prNumber={number}
                  onBack={onClose}
                />
              );
            },
          }),
        };

  // The Cockpit's `d`: dispatch without following the run (it moves into In flight in
  // place), rejecting on failure so the Cockpit can roll its optimistic move back.
  const cockpitDispatch = useCallback(
    (taskId: string) =>
      rawHandleDispatch(taskId, undefined, undefined, { batch: true }),
    [rawHandleDispatch]
  );
  const onCockpitDispatchFailed = useCallback(
    (taskId: string, message: string) =>
      feedback.onError('Dispatch', `${taskId}: ${message}`),
    [feedback]
  );

  // The draft the draft view is showing, resolved from nav state — `null` when the id
  // points at a draft that has since been dismissed or evicted.
  const activeDraft =
    navState.activeDraftId !== null
      ? (data.drafts.find((d) => d.id === navState.activeDraftId) ?? null)
      : null;

  // Destructured to bare locals rather than referenced as `data.tasks`/`data.readyIds`/
  // `data.handleDispatch` inside the memo below: `data` changes whenever any of its fields
  // does, so depending on it whole would recompute on unrelated changes — binding the fields
  // this reads to their own names lets the array list exactly what matters.
  const {
    tasks: paletteTasks,
    tasksIncludingArchived,
    readyIds: paletteReadyIds,
    handleDispatch,
    notificationInbox,
    markNotificationInboxRead,
    markNotificationRead,
  } = data;

  // Every label in use across the project — the create dialog's Labels picker candidates.
  const labelCatalogue = useMemo(() => {
    const labels = new Set<string>();
    for (const doc of paletteTasks)
      for (const l of doc.meta.labels) labels.add(l);
    return [...labels].sort((a, b) => a.localeCompare(b));
  }, [paletteTasks]);

  // Opens the Tasks board on one saved view — the rail's nested view rows, a favourite,
  // and the palette's `Open view …` rows all route here.
  const openSavedView = useCallback(
    (id: string) => {
      selectProjectView('board');
      savedViews.selectView(id);
    },
    [selectProjectView, savedViews]
  );

  // The rail's `Favorites ▾` rows, labels resolved at render time; a ref whose view or task
  // no longer exists is skipped rather than rewritten out of storage — the task list is
  // empty while it loads, and that must not wipe anyone's stars.
  const sidebarFavorites = useMemo(
    () =>
      savedViews.favorites.flatMap((ref) => {
        const label =
          ref.kind === 'view'
            ? savedViews.views.find((v) => v.id === ref.id)?.name
            : tasksIncludingArchived.find((t) => t.meta.id === ref.id)?.meta
                .title;
        return label === undefined ? [] : [{ ...ref, label }];
      }),
    [savedViews.favorites, savedViews.views, tasksIncludingArchived]
  );

  // Click-through for a notification row: a run transition opens that run's task; a target
  // that names a page rather than a record routes via `projectViewForInboxTarget`. Marks
  // the whole inbox read too — an entry can arrive while the Inbox page is already open,
  // and without this a fresh unread count would linger after the user just acted on it.
  const navigateFromInbox = useCallback(
    (target: InboxTarget) => {
      if (target.kind === 'task') {
        // The peek panel overlays whichever view is active, so this doesn't
        // need a view switch the way the run/queue targets below do.
        dispatchNav({ type: 'openPeek', taskId: target.taskId });
        markNotificationInboxRead();
        return;
      }
      if (target.kind === 'draft') {
        dispatchNav({ type: 'openDraft', draftId: target.draftId });
        markNotificationInboxRead();
        return;
      }
      // Everything left either names a page or names one run.
      const pageView = projectViewForInboxTarget(target);
      if (pageView !== null) {
        selectProjectView(pageView);
      } else if (target.kind === 'run') {
        jumpToRun(target.runId);
      }
      markNotificationInboxRead();
    },
    [selectProjectView, markNotificationInboxRead, dispatchNav, jumpToRun]
  );

  const notificationInboxValue = useMemo<NotificationInbox>(
    () => ({
      entries: notificationInbox.entries,
      unreadCount: unreadCount(notificationInbox),
      markAllRead: markNotificationInboxRead,
      markRead: markNotificationRead,
      navigate: navigateFromInbox,
    }),
    [
      notificationInbox,
      markNotificationInboxRead,
      markNotificationRead,
      navigateFromInbox,
    ]
  );

  const peekTask = useCallback(
    (taskId: string) => dispatchNav({ type: 'openPeek', taskId }),
    []
  );

  // What a `<ContainerFlightPlanSection>` draws a plan with: the project's data and the
  // Cockpit's stay-in-place dispatch.
  const flightPlanHost = useMemo<FlightPlanHost>(
    () => ({
      data,
      dispatchTask: cockpitDispatch,
      onDispatchFailed: onCockpitDispatchFailed,
      onOpenTask: openTaskView,
      onPeekTask: peekTask,
    }),
    [data, cockpitDispatch, onCockpitDispatchFailed, openTaskView, peekTask]
  );

  const openOverseer = useCallback(
    (prompt?: string) => {
      if (prompt !== undefined) overseer.setDraft(prompt);
      setGlobalView('overseer');
    },
    [overseer, setGlobalView]
  );

  // The clipboard write is best-effort: a denied permission surfaces as a toast rather than
  // a silent nothing.
  const copyTaskId = useCallback(
    (taskId: string) => {
      void navigator.clipboard
        .writeText(taskId)
        .then(() => toasts.push({ title: `Copied ${taskId}`, tone: 'success' }))
        .catch((err: unknown) =>
          toasts.push({
            title: 'Copy failed',
            description: err instanceof Error ? err.message : String(err),
            tone: 'error',
          })
        );
    },
    [toasts]
  );

  // The shell's verbs, one object every view can reach through `useShellActions()`.
  const shellActions = useMemo<ShellActions>(
    () => ({
      openTask: openTaskView,
      openThread,
      peekTask,
      openCreateTask,
      createPreset,
      closeCreateTask,
      openPalette: () => dispatchNav({ type: 'openPalette' }),
      toggleSidebar,
      sidebarHidden: sidebarCollapsed,
      openOverseer,
      setProjectView: selectProjectView,
      setGlobalView,
      openShortcuts,
      copyTaskId,
    }),
    [
      openTaskView,
      openThread,
      peekTask,
      openCreateTask,
      createPreset,
      closeCreateTask,
      toggleSidebar,
      sidebarCollapsed,
      openOverseer,
      selectProjectView,
      setGlobalView,
      openShortcuts,
      copyTaskId,
    ]
  );

  // What every page header reads for its sidebar toggle and drag region.
  const pageHeaderShell = useMemo(
    () => ({
      sidebarHidden: sidebarCollapsed,
      onToggleSidebar: toggleSidebar,
      trafficLightInset,
      dragRegion: true,
    }),
    [sidebarCollapsed, toggleSidebar, trafficLightInset]
  );

  // The palette's Docs rows for a query; none without a token that reads docs.
  const docsClient = rawData.messageAccess.canMessage ? rawData.client : null;
  const searchDocs = useMemo(
    () =>
      docsClient === null
        ? undefined
        : (query: string) =>
            docsClient
              .searchDocs(query, { limit: PALETTE_SECTION_CAPS.docs })
              .then((r) => docHitEntries(r.hits, openDoc)),
    [docsClient, openDoc]
  );

  const paletteRooms = useChannels(
    data.client,
    data.port,
    twoViews && data.messageAccess.canMessage
  );
  const palettePeers = useA2APeers(
    data.client,
    twoViews && data.messageAccess.canMessage
  );
  const paletteEntries = useMemo(
    () => [
      ...buildPaletteEntries({
        hasProject: activeProject !== null,
        views: PROJECT_NAV_VIEWS,
        tasks: paletteTasks,
        readyIds: paletteReadyIds,
        dev: import.meta.env.DEV,
        savedViews: savedViews.views,
        currentTaskId: twoViews
          ? twoViewsTaskId
          : (navState.activeTaskId ?? navState.peekTaskId),
        twoViews,
        beta: twoViewsAllowed({
          teamLocal: isTeamLocalPage(),
          tier: data.myTier,
        })
          ? [
              {
                id: 'two-views',
                label: `Turn ${twoViewsOn ? 'off' : 'on'} beta: Two views`,
                run: () => setTwoViewsOn(!twoViewsOn),
              },
            ]
          : [],
        actions: {
          openCreateTask: () => openCreateTask(),
          openQuickAddTask: () => openQuickAddTask(),
          setProjectView: selectProjectView,
          setGlobalView,
          peekTask: (taskId) => {
            selectProjectView('board');
            peekTask(taskId);
          },
          dispatchTask: (taskId) => void handleDispatch(taskId),
          openQuickCapture,
          toggleSidebar,
          openShortcuts,
          openSavedView,
          copyTaskLink,
        },
      }),
      ...(twoViews
        ? addressEntries({
            people: data.people,
            rooms: paletteRooms.map((room) => room.name),
            peers: palettePeers,
            me: data.me,
            open: (address) => dispatchNav({ type: 'tv/openAddress', address }),
          })
        : []),
    ],
    [
      activeProject,
      paletteTasks,
      paletteReadyIds,
      handleDispatch,
      selectProjectView,
      setGlobalView,
      openCreateTask,
      openQuickAddTask,
      peekTask,
      openQuickCapture,
      toggleSidebar,
      openShortcuts,
      savedViews.views,
      navState.activeTaskId,
      navState.peekTaskId,
      twoViewsTaskId,
      openSavedView,
      copyTaskLink,
      twoViews,
      twoViewsOn,
      setTwoViewsOn,
      data.myTier,
      data.people,
      data.me,
      paletteRooms,
      palettePeers,
    ]
  );

  // Resolution states for the single active project, checked in order: an outright failure to
  // resolve the project root or check it for a `.dispatch/` tracker (rare — both are local
  // filesystem operations — but `retry: false` means either can surface as an error rather
  // than hang) always wins over "still loading," and "still loading" always wins over
  // rendering the wrong thing while `root`/`rootHasDispatch` are still in flight.
  const resolutionError = rootError
    ? `Couldn't resolve the current project: ${rootErrorDetail instanceof Error ? rootErrorDetail.message : String(rootErrorDetail)}`
    : hasDispatchError
      ? `Couldn't check this project for a .dispatch/ tracker: ${hasDispatchErrorDetail instanceof Error ? hasDispatchErrorDetail.message : String(hasDispatchErrorDetail)}`
      : null;
  // The genuine first-run state: root resolution settled (`launchRoot` is `null`, not
  // `undefined` — react-query only returns `undefined` while a query is still pending) and
  // no switcher/add-project selection has overridden it either. This is NOT an error and NOT
  // "still resolving" — it's an empty `~/.dispatch/projects.json` with no launch arg and no
  // dev checkout above the binary (see `commands::resolve_project_root`), and the fix here is
  // to offer "+ Add project" instead of a fatal screen.
  const noProjectYet =
    resolutionError === null && launchRoot === null && overrideRoot === null;
  const showGetStarted =
    resolutionError === null &&
    root !== undefined &&
    root !== null &&
    rootHasDispatch === false;
  const stillResolving =
    resolutionError === null &&
    !noProjectYet &&
    (root === undefined || rootHasDispatch === undefined);
  // An initialized project with nothing on its board opens on the prompt box
  // rather than an empty home. Gated on `cockpit` — the view it lands
  // on — so navigating anywhere deliberately leaves the first run behind
  // instead of trapping someone who came to look around. Archived tasks count:
  // a board someone emptied is not a fresh project.
  const showFirstRun =
    navState.section === 'project' &&
    navState.projectView === 'cockpit' &&
    data.tasksReady &&
    data.tasksIncludingArchived.length === 0;

  // Resolution, first-project and get-started screens take precedence over any view.
  const gateScreen: ReactNode =
    resolutionError !== null ? (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <TriangleAlert className="text-destructive size-5" />
        <EmptyState message={resolutionError} className="p-0" />
      </div>
    ) : noProjectYet ? (
      <Empty className="h-full gap-4 rounded-none border-none p-0 md:p-0">
        {/* The Hydrogen mark — same wordmark icon as the sidebar, scaled up — so the
                    empty first-run state still reads as "Dispatch", not a generic error page. */}
        <EmptyMedia className="border-border mb-0 size-12 rounded-xl border bg-white p-0">
          <svg
            viewBox="0 0 34 36"
            className="size-7"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M17 0C26.3888 0 34 7.61116 34 17C34 19.6624 33.3869 22.1813 32.2959 24.4248C33.3569 25.6519 34 27.2505 34 29C34 32.866 30.866 36 27 36C24.7943 36 22.828 34.979 21.5449 33.3848C20.0982 33.7852 18.5742 34 17 34C7.61116 34 0 26.3888 0 17C0 13.7085 0.935188 10.6354 2.55469 8.03223C2.20259 7.43659 2 6.74205 2 6C2 3.79086 3.79086 2 6 2C6.74205 2 7.43659 2.20259 8.03223 2.55469C10.6354 0.935188 13.7085 0 17 0ZM17 3.40039C14.4188 3.40039 12.0051 4.11849 9.94922 5.36719C9.98199 5.57335 10 5.78461 10 6C10 8.20914 8.20914 10 6 10C5.78461 10 5.57335 9.98199 5.36719 9.94922C4.11849 12.0051 3.40039 14.4188 3.40039 17C3.40039 24.5111 9.48893 30.5996 17 30.5996C18.0707 30.5996 19.112 30.4741 20.1113 30.2402C20.0393 29.8376 20 29.4233 20 29C20 25.134 23.134 22 27 22C27.8672 22 28.6974 22.158 29.4639 22.4463C30.1936 20.7786 30.5996 18.9369 30.5996 17C30.5996 9.48893 24.5111 3.40039 17 3.40039Z"
              fill="#000000"
            />
          </svg>
        </EmptyMedia>
        <EmptyHeader className="gap-1">
          <EmptyTitle className="text-[15px] tracking-normal">
            No project yet
          </EmptyTitle>
          <EmptyDescription className="max-w-sm text-[13px]">
            Add a local folder or clone a repository from GitHub to get started.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={() => setAddProjectOpen(true)}>
            <Plus className="size-4" />
            Add project
          </Button>
        </EmptyContent>
      </Empty>
    ) : stillResolving ? (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <Spinner className="text-muted-foreground size-5" />
        <EmptyState message="Loading project…" className="p-0" />
      </div>
    ) : showGetStarted ? (
      <GetStartedView projectPath={root} />
    ) : null;

  const projectSwitcher = (
    <ProjectSwitcher
      teamSession={teamSession}
      projectName={activeProject?.name ?? null}
      projectPath={activeProject?.path ?? null}
      noProjectYet={noProjectYet}
      open={switcherOpen}
      onOpenChange={setSwitcherOpen}
      switchProjects={switchProjects ?? []}
      onSelectProject={selectSwitchProject}
      onAddProject={() => {
        setSwitcherOpen(false);
        setAddProjectOpen(true);
      }}
      onOpenSettings={() => setGlobalView('settings')}
      onOpenGallery={
        import.meta.env.DEV ? () => setGlobalView('gallery') : undefined
      }
    />
  );

  const peekTaskId = twoViews
    ? twoViewsState.peek?.kind === 'task'
      ? twoViewsState.peek.taskId
      : null
    : navState.peekTaskId;

  const closeTwoViewsPage = () => dispatchNav({ type: 'tv/closePage' });

  // A classic project view shown as a page under Tasks, its own header leading back.
  const renderHostedView = (view: HostedView): ReactNode => {
    if (data.portLoading || data.portError || data.client === null) {
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="px-4 pt-2">
            <TasksBackButton onBack={closeTwoViewsPage} />
          </div>
          <DaemonUnavailable
            starting={data.portLoading}
            errorDetail={data.portErrorDetail}
            onRetry={data.retryEnsureDispatchd}
          />
        </div>
      );
    }
    switch (view) {
      case 'branches':
        return (
          <BranchesView
            data={data}
            onOpenRun={jumpToRun}
            onOpenImpact={(subject) =>
              dispatchNav({ type: 'openImpact', subject })
            }
            onBack={closeTwoViewsPage}
          />
        );
      case 'files':
        return <FilesView data={data} onBack={closeTwoViewsPage} />;
      case 'terminals':
        return <TerminalsView data={data} onBack={closeTwoViewsPage} />;
      case 'design':
        return <DesignView data={data} onBack={closeTwoViewsPage} />;
      case 'brain-dump':
        return (
          <BrainDumpView
            data={data}
            onOpenTask={(taskId) => dispatchNav({ type: 'openPeek', taskId })}
            onPlanText={openOverseer}
            onBack={closeTwoViewsPage}
          />
        );
    }
  };

  // What Tasks shows beside or instead of its list.
  const renderTwoViewsPage = (page: TasksSidePage): ReactNode => {
    switch (page.kind) {
      case 'task':
        return data.config === null ? null : (
          <TaskPage
            key={page.taskId}
            layout={page.full ? 'full' : 'split'}
            taskId={page.taskId}
            mode={page.tab}
            onModeChange={(tab) => dispatchNav({ type: 'setTaskTab', tab })}
            runId={page.runId}
            onSelectRun={(runId) => dispatchNav({ type: 'openRun', runId })}
            onClose={closeTwoViewsPage}
            onExpand={() => dispatchNav({ type: 'tv/expandTask' })}
            onBack={closeTwoViewsPage}
            conversationCount={speechByTask.get(page.taskId)?.count ?? 0}
          />
        );
      case 'docs':
        return (
          <DocsView
            data={data}
            initialDoc={page.docId}
            initialAnchor={page.anchor}
            initialMerge={page.merge}
            onSelectDoc={(docId) => openDoc(docId, null)}
            onOpenRef={openRef}
            tasksPage={{
              onBack: closeTwoViewsPage,
              onOpenAllDocs: () =>
                dispatchNav({ type: 'setProjectView', view: 'docs' }),
            }}
            discussion={(docId) => (
              <ConversationTimeline
                key={docId}
                data={data}
                query={{ about: `doc:${docId}` }}
                composerTo={null}
                composerLabel=""
                onOpenRef={openRef}
                header={<SectionLabel>Discussion</SectionLabel>}
                emptyText="No discussion yet. Messages that reference this doc show here."
              />
            )}
          />
        );
      case 'pr':
        return (
          <PrReviewView
            projectName={activeProject?.name ?? null}
            key={page.number}
            data={data}
            prNumber={page.number}
            onBack={closeTwoViewsPage}
            tasksPage
          />
        );
      case 'draft': {
        const draft = data.drafts.find((d) => d.id === page.draftId);
        return draft === undefined || data.config === null ? (
          <EmptyState
            className="h-full"
            message="That draft is no longer available."
          />
        ) : (
          <DraftView
            projectName={activeProject?.name}
            key={draft.id}
            data={data}
            onCreate={rawData.handleCreate}
            draft={draft}
            onDone={closeTwoViewsPage}
          />
        );
      }
      case 'room':
        return (
          <RoomHome
            data={data}
            room={page.room}
            onOpenRef={openRef}
            onBack={closeTwoViewsPage}
          />
        );
      case 'view':
        return renderHostedView(page.view);
      case 'impact':
        return (
          <ImpactView
            key={
              page.subject === null
                ? 'impact-empty'
                : `${page.subject.kind}:${page.subject.id}`
            }
            data={data}
            initialSubject={page.subject}
            onBack={closeTwoViewsPage}
          />
        );
    }
  };

  const onOpenDecision = (item: DecisionItem) => {
    const target = decisionTarget(item);
    if (target === null) return;
    if (target.kind === 'task') {
      openTaskView(target.taskId, target.tab, target.runId ?? undefined);
    } else if (target.kind === 'run') {
      jumpToRun(target.runId);
    } else {
      openThread(target.messageId);
    }
  };

  const tasksPage = twoViewsState.tasksPage;
  const aboutTask =
    tasksPage.kind === 'task'
      ? {
          taskId: tasksPage.taskId,
          title:
            data.tasksIncludingArchived.find(
              (t) => t.meta.id === tasksPage.taskId
            )?.meta.title ?? tasksPage.taskId,
        }
      : null;

  // Sessions, All agents and the Gallery as Settings pages in Two views.
  const hostedSettingsPages: HostedSettingsPage[] = [
    {
      id: 'usage',
      label: 'Usage',
      icon: Coins,
      intro: 'Every agent session and what it cost.',
      render: () => <SessionsHubView />,
    },
    {
      id: 'runs',
      label: 'Runs',
      icon: Bot,
      intro: 'Every run, including archived ones.',
      render: () => (
        <AllAgentsView
          runs={data.visibleRuns}
          sessions={data.agentSessions}
          archivedRunCount={archivedRunCount}
          showArchived={data.showArchived}
          onSetShowArchived={data.setShowArchived}
          onArchiveRun={(runId, archived) =>
            void data.handleArchiveRun(runId, archived)
          }
          portLoading={data.portLoading}
          portError={data.portError}
          portErrorDetail={data.portErrorDetail}
          client={data.client}
          onRetry={data.retryEnsureDispatchd}
          onJumpToRun={jumpToRun}
        />
      ),
    },
    ...(import.meta.env.DEV
      ? [
          {
            id: 'developer' as const,
            label: 'Developer',
            icon: Wrench,
            intro: 'The component gallery, in dev builds only.',
            render: () => <GalleryView />,
          },
        ]
      : []),
  ];

  // A link inside a peek closes it, so the peek never sits over where it led.
  const openRefFromPeek = (action: RefAction) => {
    dispatchNav({ type: 'tv/closePeek' });
    openRef(action);
  };
  const closePeek = () => dispatchNav({ type: 'tv/closePeek' });
  const peek = twoViewsState.peek;
  const peekView: ReactNode =
    peek?.kind === 'thread' ? (
      <ThreadPeek
        key={peek.messageId}
        data={data}
        overseer={overseer}
        messageId={peek.messageId}
        onOpenRef={openRefFromPeek}
        onOpenHome={(address) =>
          dispatchNav({ type: 'tv/openAddress', address })
        }
        onShowOverseer={() => dispatchNav({ type: 'tv/showOverseer' })}
        onClose={closePeek}
      />
    ) : peek?.kind === 'person' ? (
      <PersonPeek
        key={peek.address}
        data={data}
        address={peek.address}
        onOpenRef={openRefFromPeek}
        onClose={closePeek}
      />
    ) : peek?.kind === 'outside' ? (
      <OutsidePeek
        key={peek.address}
        data={data}
        address={peek.address}
        onOpenRef={openRefFromPeek}
        onOpenA2ASettings={() =>
          dispatchNav({ type: 'tv/openSettings', page: 'a2a' })
        }
        onClose={closePeek}
      />
    ) : null;

  // "For you" posts: built from the mailbox, never stored; agents' messages count too.
  const followedRooms = useMemo(
    () =>
      new Set(
        paletteRooms
          .filter((room) => data.me !== null && room.members.includes(data.me))
          .map((room) => `channel:${room.name}`)
      ),
    [paletteRooms, data.me]
  );
  // Each row's speech cell: unread messages to me about its task, never chatter.
  const speechByTask = useMemo(() => {
    const out = new Map<string, { count: number; mention: boolean }>();
    const me = data.me;
    if (!twoViews || me === null) return out;
    for (const { delivery, message } of mailbox ?? []) {
      if (delivery.recipient !== me) continue;
      if (!['held', 'notified', 'pushed'].includes(delivery.state)) continue;
      if (message.from.startsWith('run:') || message.from === me) continue;
      const subject = subjectOf(message, me);
      if (!subject.startsWith('task:')) continue;
      const id = subject.slice('task:'.length);
      const cell = out.get(id) ?? { count: 0, mention: false };
      cell.count++;
      if (mentions(message.body, me)) cell.mention = true;
      out.set(id, cell);
    }
    return out;
  }, [twoViews, data.me, mailbox]);
  const posts = useMemo(
    () =>
      !twoViews || data.me === null
        ? []
        : buildPosts(mailbox ?? [], {
            me: data.me,
            myTaskIds,
            followed: followedRooms,
            // The agent's own lines are already the stream; never a post too.
            muted: new Set([overseerOf(data.me)]),
            authorOf: () => null,
            now: Date.now(),
          }),
    [twoViews, data.me, mailbox, myTaskIds, followedRooms]
  );
  // An agent or narrator door: Tasks on a task, a milestone or a preset.
  const openDoor = (door: OverseerDoor) => {
    const taskId = door.taskId ?? door.milestoneId;
    dispatchNav(
      taskId !== undefined
        ? { type: 'openTask', taskId }
        : { type: 'tv/showTasks', preset: door.preset }
    );
  };
  // What a side column of the Overseer opened in its middle.
  const [overseerFocus, setOverseerFocus] = useState<OverseerFocus | null>(
    null
  );
  const addressName = (address: string) =>
    data.people.find((p) => p.ref === address)?.name ??
    address.replace(/^(human|a2a|run|agent):/, '');
  const openPost = (post: Post) => {
    const client = data.client;
    if (client !== null) {
      void Promise.all(
        post.deliveries.map((d) => client.markDeliveryRead(d.id))
      ).then(() =>
        queryClient.invalidateQueries({ queryKey: threadListsKey(data.port) })
      );
    }
    // It opens in the Overseer's middle: a task on its conversation, else that talk.
    setOverseerFocus(
      post.subject.startsWith('task:')
        ? {
            kind: 'task',
            taskId: post.subject.slice('task:'.length),
            conversation: true,
          }
        : { kind: 'address', address: post.subject }
    );
  };
  const replyToPost = async (post: Post, body: string) => {
    if (data.client === null) throw new Error('dispatchd client not ready');
    await data.client.sendMessage(
      { to: [post.subject], kind: 'message', body },
      { continueThread: true }
    );
    void queryClient.invalidateQueries({
      queryKey: threadListsKey(data.port),
    });
  };

  const twoViewsFrame = twoViews ? (
    <PageHeaderShellContext.Provider value={TWO_VIEWS_PAGE_HEADER}>
      <TwoViewShell
        view={twoViewsState.mainView}
        gate={gateScreen}
        topBar={{
          view: twoViewsState.mainView,
          orb,
          orbLabel: orbTitle,
          postsDot: posts.some((post) => post.unread),
          onShowOverseer: () => dispatchNav({ type: 'tv/showOverseer' }),
          onShowTasks: () => dispatchNav({ type: 'tv/showTasks' }),
          onCount: (count) =>
            dispatchNav(
              count === 'asks'
                ? { type: 'tv/showTasks' }
                : {
                    type: 'tv/showTasks',
                    preset: count === 'working' ? 'moving' : count,
                  }
            ),
          counts: {
            asks: needs.count,
            review: statusCounts.buckets.review,
            failed: statusCounts.buckets.failed,
            working: statusCounts.buckets.working,
          },
          settingsCount: admin.reduce((n, item) => n + item.count, 0),
          settingsTitle:
            admin.length === 0
              ? undefined
              : admin.map((item) => item.label).join(' · '),
          onOpenSettings: () =>
            dispatchNav({ type: 'tv/openSettings', page: admin[0]?.page }),
          settingsOpen: twoViewsState.settings !== null,
          projectMenu: (
            <div className="flex items-center gap-1">
              {projectSwitcher}
              {activeProject !== null && (
                <PresenceStack
                  presence={data.presence}
                  onOpenPerson={(ref) =>
                    dispatchNav({ type: 'tv/openAddress', address: ref })
                  }
                  taskTitle={(id) =>
                    data.tasksIncludingArchived.find((t) => t.meta.id === id)
                      ?.meta.title
                  }
                />
              )}
            </div>
          ),
          trafficLightInset,
        }}
        overseer={
          <TwoViewOverseer
            data={data}
            overseer={overseer}
            projectPath={activeProject?.path ?? null}
            asks={needs.count}
            postsCount={posts.length}
            runs={data.runs}
            merges={data.mergeQueue?.entries ?? []}
            focus={overseerFocus}
            onFocus={setOverseerFocus}
            renderFocus={(focus, onClose) => (
              <OverseerFocusView
                focus={focus}
                data={data}
                name={addressName}
                conversationCount={(taskId) =>
                  speechByTask.get(taskId)?.count ?? 0
                }
                onOpenRef={openRef}
                onOpenInTasks={(taskId) => {
                  onClose();
                  openTaskView(taskId, 'auto');
                }}
                onClose={onClose}
              />
            )}
            needsBlock={
              <NeedsYouBlock
                data={data}
                needs={needs}
                decided={recentlyDecided}
                // Beside the talk, a task opens in the middle instead of in Tasks.
                onOpenRef={(action) =>
                  action.kind === 'task' || action.kind === 'run'
                    ? setOverseerFocus({ kind: 'task', taskId: action.taskId })
                    : openRef(action)
                }
                onOpenDecision={(item) => {
                  const target = decisionTarget(item);
                  if (target?.kind === 'task') {
                    setOverseerFocus({ kind: 'task', taskId: target.taskId });
                  } else {
                    onOpenDecision(item);
                  }
                }}
                flush
              />
            }
            revoked={overseer.revoked}
            onShowAsks={() => dispatchNav({ type: 'tv/showTasks' })}
            onOpenDoor={openDoor}
            onOpenConnectedAgents={() =>
              dispatchNav({
                type: 'tv/openSettings',
                page: 'connected-agents',
              })
            }
            posts={
              <>
                <AwayDigest
                  lines={digest}
                  since={narrator.since}
                  onDismiss={narrator.dismiss}
                  onOpenDoor={openDoor}
                />
                <ForYouPosts
                  posts={posts}
                  label={addressName}
                  onOpen={openPost}
                  onReply={replyToPost}
                  holding={overseerTurnLive(overseer)}
                />
              </>
            }
          />
        }
        tasks={
          <TasksView
            data={data}
            needs={needs}
            decided={recentlyDecided}
            counts={statusCounts}
            page={tasksPage}
            mode={twoViewsState.tasksMode}
            onModeChange={(mode) =>
              dispatchNav({ type: 'tv/setTasksMode', mode })
            }
            preset={twoViewsState.tasksPreset}
            onPreset={(preset) =>
              dispatchNav({ type: 'tv/setTasksPreset', preset })
            }
            presetContext={presetContext}
            onSelectTask={selectBoardTask}
            onNewTask={() => openCreateTask()}
            onOpenRef={openRef}
            onOpenDecision={onOpenDecision}
            onClosePage={closeTwoViewsPage}
            projectKey={activeProject?.path ?? ''}
            speechByTask={speechByTask}
            onOpenPr={(number) => dispatchNav({ type: 'openPr', number })}
            onOpenDoc={(docId) => openDoc(docId, null)}
            onOpenAllDocs={() =>
              dispatchNav({ type: 'setProjectView', view: 'docs' })
            }
            onOpenNotes={() =>
              dispatchNav({ type: 'setProjectView', view: 'brain-dump' })
            }
            renderPage={renderTwoViewsPage}
            composer={
              <TasksComposer
                overseer={overseer}
                about={aboutTask}
                onOpenOverseer={() => dispatchNav({ type: 'tv/showOverseer' })}
                disabled={overseer.revoked}
              />
            }
          />
        }
        peek={peekView}
      />
      {twoViewsState.settings !== null && (
        <SettingsPanel
          activeProject={activeProject}
          data={settingsData}
          initialPage={twoViewsState.settings}
          onOpenTask={(taskId) => openTaskView(taskId, 'auto')}
          hostedPages={hostedSettingsPages}
          pageExtras={{
            autonomy:
              data.client === null ? null : (
                <OverseerGrantsGroup
                  client={data.client}
                  port={data.port}
                  conversationId={overseer.conversationId}
                />
              ),
            memory:
              data.client === null ? null : (
                <MemoryRecent client={data.client} port={data.port} />
              ),
          }}
          onClose={() => dispatchNav({ type: 'tv/closeSettings' })}
        />
      )}
    </PageHeaderShellContext.Provider>
  ) : null;

  return (
    <TooltipProvider>
      <ShellActionsProvider value={shellActions}>
        <NotificationInboxProvider value={notificationInboxValue}>
          <DeepLinkProvider value={deepLinkActions}>
            <SavedViewsProvider value={savedViews}>
              <PageHeaderShellContext.Provider value={pageHeaderShell}>
                <PeopleProvider people={data.people} me={data.me}>
                  <SurfaceHosts
                    taskPage={taskPageHost}
                    flightPlan={flightPlanHost}
                  >
                    {/* Linear's frame: the window is the dark frame, the rail sits directly on it, and
          the content is one rounded panel inset 8px from the top and right with the status
          strip in the 36px below. Views own their inset from here on — the panel has no
          padding of its own. */}
                    <div className="bg-frame relative flex h-screen flex-col overflow-hidden">
                      {twoViewsFrame ?? (
                        <>
                          <SidebarProvider
                            open={!sidebarCollapsed}
                            onOpenChange={(open) => setSidebarCollapsed(!open)}
                            className="flex min-h-0 flex-1 overflow-hidden"
                          >
                            <Sidebar
                              hasActiveProject={activeProject !== null}
                              hideHostViews={
                                isTeamLocalPage() && data.myTier !== 'operator'
                              }
                              section={navState.section}
                              projectView={navState.projectView}
                              globalView={navState.globalView}
                              trafficLightInset={trafficLightInset}
                              switcher={projectSwitcher}
                              onOpenPalette={() =>
                                dispatchNav({ type: 'openPalette' })
                              }
                              onNewTask={() => openCreateTask()}
                              inboxCount={inboxData.total}
                              threadsNeedsYouCount={threadsNeedsYou}
                              overseerPendingCount={
                                (overseer.record?.pendingActions.length ?? 0) +
                                (overseer.record?.pendingApprovals.length ?? 0)
                              }
                              liveAgentCount={liveRuns.length}
                              drafts={data.drafts}
                              onOpenDraft={(draftId) =>
                                dispatchNav({ type: 'openDraft', draftId })
                              }
                              onDismissDraft={(id) =>
                                void data.handleDismissDraft(id)
                              }
                              onSetProjectView={selectProjectView}
                              onSetGlobalView={setGlobalView}
                              onQuickCapture={openQuickCapture}
                              savedViews={savedViews.views}
                              favorites={sidebarFavorites}
                              activeSavedViewId={
                                navState.projectView === 'board'
                                  ? savedViews.activeViewId
                                  : null
                              }
                              onSelectSavedView={openSavedView}
                              onOpenFavorite={(ref) =>
                                ref.kind === 'view'
                                  ? openSavedView(ref.id)
                                  : openTaskView(ref.id)
                              }
                              // Project scope only — the global views have no runs to show.
                              liveRail={
                                navState.section === 'project' &&
                                activeProject !== null ? (
                                  <LiveRail
                                    runs={data.runs}
                                    overseer={overseer}
                                    sessions={data.liveEpicSessions}
                                    epics={data.epics}
                                    onOpenTask={openTaskView}
                                    onOpenOverseer={() =>
                                      setGlobalView('overseer')
                                    }
                                    onOpenMilestone={(id) => openMilestone(id)}
                                  />
                                ) : null
                              }
                            />
                            {/* With the rail hidden the panel keeps an 8px margin on the left too, so it
                    reads as inset on every side rather than flush against the window edge. */}
                            <div
                              className={cn(
                                'flex min-w-0 flex-1 flex-col pt-2 pr-2 pb-9',
                                sidebarCollapsed && 'pl-2'
                              )}
                            >
                              <main className="bg-background border-border-panel shadow-panel rounded-popover min-h-0 flex-1 overflow-hidden border-[0.5px]">
                                <ErrorBoundary label="this page">
                                  {gateScreen !== null ? (
                                    gateScreen
                                  ) : showFirstRun ? (
                                    <FirstRunView
                                      projectName={activeProject?.name ?? null}
                                      onStartDraft={rawData.handleStartDraft}
                                      onBrowseBoard={() =>
                                        dispatchNav({
                                          type: 'setProjectView',
                                          view: 'board',
                                        })
                                      }
                                    />
                                  ) : navState.section === 'global' ? (
                                    <>
                                      {navState.globalView === 'all-agents' && (
                                        <AllAgentsView
                                          // `visibleRuns`, not `runs`: this is the run *list* the archive filter
                                          // was built for, and the only surface left that can unarchive one.
                                          runs={data.visibleRuns}
                                          // The non-run agents (planners, enrich, drafts, overseers) — archiving
                                          // never applies to them, so they bypass the archive filter.
                                          sessions={data.agentSessions}
                                          archivedRunCount={archivedRunCount}
                                          showArchived={data.showArchived}
                                          onSetShowArchived={
                                            data.setShowArchived
                                          }
                                          onArchiveRun={(runId, archived) =>
                                            void data.handleArchiveRun(
                                              runId,
                                              archived
                                            )
                                          }
                                          portLoading={data.portLoading}
                                          portError={data.portError}
                                          portErrorDetail={data.portErrorDetail}
                                          client={data.client}
                                          onRetry={data.retryEnsureDispatchd}
                                          onJumpToRun={jumpToRun}
                                        />
                                      )}
                                      {navState.globalView === 'sessions' && (
                                        <SessionsHubView />
                                      )}
                                      {navState.globalView === 'overseer' && (
                                        <OverseerView
                                          data={data}
                                          overseer={overseer}
                                        />
                                      )}
                                      {navState.globalView === 'settings' && (
                                        <SettingsView
                                          activeProject={activeProject}
                                          data={settingsData}
                                          initialPage={
                                            navState.settingsPage ?? 'general'
                                          }
                                          onOpenTask={(taskId) =>
                                            openTaskView(taskId, 'auto')
                                          }
                                        />
                                      )}
                                      {import.meta.env.DEV &&
                                        navState.globalView === 'gallery' && (
                                          <GalleryView />
                                        )}
                                    </>
                                  ) : activeProject === null ? (
                                    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                                      <Spinner className="text-muted-foreground size-5" />
                                      <EmptyState
                                        message="Loading project…"
                                        className="p-0"
                                      />
                                    </div>
                                  ) : (
                                    <>
                                      {navState.projectView === 'cockpit' && (
                                        <CockpitView
                                          projectName={
                                            activeProject?.name ?? null
                                          }
                                          data={data}
                                          dispatchTask={cockpitDispatch}
                                          onDispatchFailed={
                                            onCockpitDispatchFailed
                                          }
                                          onOpenTask={openTaskView}
                                          onPeekTask={peekTask}
                                          onOpenLive={() =>
                                            selectProjectView('live')
                                          }
                                        />
                                      )}
                                      {navState.projectView === 'live' && (
                                        <LiveView
                                          projectName={
                                            activeProject?.name ?? null
                                          }
                                          data={data}
                                          dispatchTask={cockpitDispatch}
                                          onDispatchFailed={
                                            onCockpitDispatchFailed
                                          }
                                          onOpenTask={openTaskView}
                                          onPeekTask={peekTask}
                                        />
                                      )}
                                      {navState.projectView === 'overview' && (
                                        <OverviewView
                                          projectName={
                                            activeProject?.name ?? null
                                          }
                                          data={data}
                                          onOpenTask={(taskId) =>
                                            dispatchNav({
                                              type: 'openPeek',
                                              taskId,
                                            })
                                          }
                                          onOpenRun={jumpToRun}
                                          onReviewRun={(runId) => {
                                            const run = data.runs.find(
                                              (r) => r.id === runId
                                            );
                                            if (run !== undefined) {
                                              openTaskView(
                                                run.taskId,
                                                'review',
                                                run.id
                                              );
                                            }
                                          }}
                                          onGoToBoard={() =>
                                            selectProjectView('board')
                                          }
                                        />
                                      )}
                                      {navState.projectView === 'projects' && (
                                        <ProjectsView
                                          projectName={
                                            activeProject?.name ?? null
                                          }
                                          data={data}
                                          onOpenTask={openTaskView}
                                        />
                                      )}
                                      {navState.projectView === 'inbox' && (
                                        <InboxView
                                          projectName={
                                            activeProject?.name ?? null
                                          }
                                          projectRoot={
                                            activeProject?.path ?? null
                                          }
                                          data={inboxData}
                                          project={data}
                                          onOpenTask={openTaskView}
                                          onOpenPr={(number) =>
                                            dispatchNav({
                                              type: 'openPr',
                                              number,
                                            })
                                          }
                                          onOpenDoc={(id) => openDoc(id, null)}
                                        />
                                      )}
                                      {navState.projectView === 'threads' && (
                                        <ThreadsView
                                          data={data}
                                          projectName={
                                            activeProject?.name ?? null
                                          }
                                          focus={navState.threadFocus}
                                          onFocus={openThread}
                                          onOpenRef={openRef}
                                          overseer={{
                                            thread:
                                              overseer.record?.thread ?? null,
                                            busy:
                                              overseer.sending ||
                                              overseer.record?.state ===
                                                'running',
                                            submit: overseer.reply,
                                            open: () =>
                                              setGlobalView('overseer'),
                                          }}
                                        />
                                      )}
                                      {navState.projectView === 'landing' && (
                                        <LandingTableView
                                          projectName={
                                            activeProject?.name ?? null
                                          }
                                          data={data}
                                          onOpenRun={(taskId, runId) =>
                                            openTaskView(
                                              taskId,
                                              'review',
                                              runId
                                            )
                                          }
                                          onOpenPr={(number) =>
                                            dispatchNav({
                                              type: 'openPr',
                                              number,
                                            })
                                          }
                                        />
                                      )}
                                      {navState.projectView === 'pr' &&
                                        navState.activePrNumber !== null && (
                                          <PrReviewView
                                            projectName={
                                              activeProject?.name ?? null
                                            }
                                            key={navState.activePrNumber}
                                            data={data}
                                            prNumber={navState.activePrNumber}
                                            onBack={() =>
                                              dispatchNav({ type: 'back' })
                                            }
                                          />
                                        )}
                                      {navState.projectView === 'impact' && (
                                        // Keyed by the preselected subject so arriving with a new
                                        // one (a different "open in Impact" click) resets the
                                        // view's local picker/filter state instead of reusing
                                        // whatever was left over from the last subject.
                                        <ImpactView
                                          projectName={
                                            activeProject?.name ?? null
                                          }
                                          key={
                                            navState.impactSubject === null
                                              ? 'impact-empty'
                                              : `${navState.impactSubject.kind}:${navState.impactSubject.id}`
                                          }
                                          data={data}
                                          initialSubject={
                                            navState.impactSubject
                                          }
                                        />
                                      )}
                                      {navState.projectView === 'board' && (
                                        <BoardView
                                          projectName={
                                            activeProject?.name ?? null
                                          }
                                          data={data}
                                          mode={tasksViewMode}
                                          focusEpic={focusEpic}
                                          onSelectTask={selectBoardTask}
                                          onNewTask={(status) =>
                                            openCreateTask(
                                              status !== undefined
                                                ? { status }
                                                : undefined
                                            )
                                          }
                                          onPlanWork={() =>
                                            selectProjectView('plans')
                                          }
                                        />
                                      )}
                                      {navState.projectView === 'task' &&
                                        navState.activeTaskId !== null &&
                                        data.config !== null && (
                                          <TaskPage
                                            key={navState.activeTaskId}
                                            layout="full"
                                            taskId={navState.activeTaskId}
                                            mode={navState.taskTab}
                                            onModeChange={(tab) =>
                                              dispatchNav({
                                                type: 'setTaskTab',
                                                tab,
                                              })
                                            }
                                            runId={navState.activeRunId}
                                            onSelectRun={(runId) =>
                                              openTaskView(
                                                navState.activeTaskId,
                                                navState.taskTab,
                                                runId
                                              )
                                            }
                                            onBack={() =>
                                              dispatchNav({ type: 'back' })
                                            }
                                          />
                                        )}
                                      {navState.projectView === 'branches' && (
                                        <BranchesView
                                          projectName={
                                            activeProject?.name ?? null
                                          }
                                          data={data}
                                          onOpenRun={jumpToRun}
                                          onOpenImpact={(subject) =>
                                            dispatchNav({
                                              type: 'openImpact',
                                              subject,
                                            })
                                          }
                                        />
                                      )}
                                      {navState.projectView === 'design' && (
                                        <DesignView data={data} />
                                      )}
                                      {navState.projectView === 'files' && (
                                        <FilesView data={data} />
                                      )}
                                      {navState.projectView === 'docs' && (
                                        <DocsView
                                          data={data}
                                          initialDoc={navState.activeDocId}
                                          initialAnchor={
                                            navState.activeDocAnchor
                                          }
                                          initialMerge={navState.activeDocMerge}
                                          onSelectDoc={(docId) =>
                                            openDoc(docId, null)
                                          }
                                          onOpenRef={openRef}
                                        />
                                      )}
                                      {navState.projectView === 'terminals' && (
                                        <TerminalsView data={data} />
                                      )}
                                      {navState.projectView ===
                                        'brain-dump' && (
                                        <BrainDumpView
                                          data={data}
                                          onOpenTask={(taskId) =>
                                            dispatchNav({
                                              type: 'openPeek',
                                              taskId,
                                            })
                                          }
                                          onPlanText={(text) => {
                                            setPlanSeed(text);
                                            selectProjectView('plans');
                                          }}
                                        />
                                      )}
                                      {navState.projectView === 'plans' && (
                                        <PlansView
                                          projectName={activeProject?.name}
                                          data={data}
                                          onGoToBoard={() =>
                                            selectProjectView('board')
                                          }
                                          onOpenMilestone={openMilestone}
                                          initialPrompt={planSeed ?? undefined}
                                          key={planSeed ?? 'plans'}
                                        />
                                      )}
                                      {navState.projectView === 'draft' &&
                                        (activeDraft !== null &&
                                        data.config !== null ? (
                                          <DraftView
                                            projectName={activeProject?.name}
                                            key={activeDraft.id}
                                            data={data}
                                            onCreate={rawData.handleCreate}
                                            draft={activeDraft}
                                            onDone={() =>
                                              selectProjectView('board')
                                            }
                                          />
                                        ) : data.config === null ? (
                                          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                                            <Spinner className="text-muted-foreground size-5" />
                                            <EmptyState
                                              message="Loading project…"
                                              className="p-0"
                                            />
                                          </div>
                                        ) : (
                                          <div className="flex h-full items-center justify-center">
                                            <EmptyState
                                              message="That draft is no longer available."
                                              action={
                                                <Button
                                                  size="sm"
                                                  onClick={() =>
                                                    selectProjectView('board')
                                                  }
                                                >
                                                  Back to board
                                                </Button>
                                              }
                                            />
                                          </div>
                                        ))}
                                    </>
                                  )}
                                </ErrorBoundary>
                              </main>
                            </div>
                          </SidebarProvider>
                          <FrameStatusStrip
                            className="absolute inset-x-0 bottom-0"
                            syncStatus={
                              activeProject !== null ? data.syncStatus : null
                            }
                            // autoCommit is an operator-only key, so only the owner is offered it.
                            onDisableAutoCommit={
                              accessFor(
                                data.myTier,
                                data.attachedWithoutAppToken
                              ).canOperate
                                ? () =>
                                    void data.handleUpdateConfig({
                                      autoCommit: false,
                                    })
                                : undefined
                            }
                            spendToday={todaySpend}
                            ceilings={liveCeilings}
                            onOpenShortcuts={openShortcuts}
                            onOpenSettings={() =>
                              setGlobalView('settings', {
                                page: 'integrations',
                              })
                            }
                            onOpenOverseer={() => setGlobalView('overseer')}
                            presence={
                              activeProject !== null ? data.presence : []
                            }
                            taskTitle={(id) =>
                              data.tasksIncludingArchived.find(
                                (t) => t.meta.id === id
                              )?.meta.title
                            }
                          />
                        </>
                      )}

                      <QuickCaptureDialog
                        open={quickCaptureOpen}
                        onOpenChange={setQuickCaptureOpen}
                        onCapture={rawData.handleCaptureInbox}
                        onOpenBrainDump={() => selectProjectView('brain-dump')}
                      />

                      <ShortcutsDialog
                        open={navState.shortcutsOpen}
                        onOpenChange={(open) => {
                          if (!open) dispatchNav({ type: 'closeShortcuts' });
                        }}
                      />

                      {peekTaskId !== null && (
                        // Remount per task so per-task state (a picked run, an in-flight
                        // dispatch) never leaks across a peek re-pointed at another task.
                        <TaskPeekDialog
                          key={peekTaskId}
                          taskId={peekTaskId}
                          onClose={() => dispatchNav({ type: 'closePeek' })}
                          onExpand={(taskId) => openTaskView(taskId)}
                        />
                      )}

                      {showCreate && data.config !== null && (
                        <CreateTaskModal
                          projectName={activeProject?.name}
                          statuses={data.config.statuses}
                          epics={data.epics}
                          initialStatus={createPreset?.status}
                          labels={labelCatalogue}
                          onCreate={(input) => data.handleCreate(input)}
                          onUploadAttachments={data.handleUploadAttachments}
                          onClose={() => setShowCreate(false)}
                        />
                      )}

                      {aiComposerOpen && (
                        <AiTaskComposer
                          projectName={activeProject?.name}
                          data={data}
                          onStartDraft={rawData.handleStartDraft}
                          onQuickAdd={(preset) => {
                            setAiComposerOpen(false);
                            openQuickAddTask(preset);
                          }}
                          onClose={() => setAiComposerOpen(false)}
                        />
                      )}

                      {addProjectOpen && (
                        <AddProjectDialog
                          onAdd={handleAddProject}
                          onClose={() => setAddProjectOpen(false)}
                        />
                      )}

                      <CommandPalette
                        isOpen={navState.paletteOpen}
                        entries={paletteEntries}
                        onClose={() => dispatchNav({ type: 'closePalette' })}
                        searchDocs={searchDocs}
                        twoViews={twoViews}
                      />
                    </div>
                  </SurfaceHosts>
                </PeopleProvider>
              </PageHeaderShellContext.Provider>
            </SavedViewsProvider>
          </DeepLinkProvider>
        </NotificationInboxProvider>
      </ShellActionsProvider>
    </TooltipProvider>
  );
}

export default App;
