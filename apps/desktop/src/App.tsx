import { useQuery } from '@tanstack/react-query';
import { Plus, TriangleAlert } from 'lucide-react';
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

import {
  type FlightPlanHost,
  FlightPlanHostContext,
} from './components/flightplan/ContainerFlightPlanSection';
import { PeopleProvider } from './components/people/PeopleContext';
import { accessFor } from './components/settings/access';
import { AddProjectDialog } from './components/shell/AddProjectDialog';
import { CommandPalette } from './components/shell/CommandPalette';
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
import { ProjectSwitcher } from './components/shell/ProjectSwitcher';
import { QuickCaptureDialog } from './components/shell/QuickCaptureDialog';
import { SavedViewsProvider } from './components/shell/SavedViewsContext';
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
import { AiTaskComposer } from './components/tasks/AiTaskComposer';
import { CreateTaskModal } from './components/tasks/CreateTaskModal';
import { TaskPage } from './components/tasks/page/TaskPage';
import {
  type TaskPageHost,
  TaskPageHostContext,
} from './components/tasks/page/TaskPageHost';
import { TaskPeekDialog } from './components/tasks/TaskPeekDialog';
import { TaskThreadTab } from './components/tasks/TaskThreadTab';
import { useDataChangedEvents } from './hooks/useDataChangedEvents';
import { useDeepLinkRouter } from './hooks/useDeepLinkRouter';
import { useDispatchProject } from './hooks/useDispatchProject';
import { useDocList } from './hooks/useDocs';
import { useGlobalKeyboard } from './hooks/useGlobalKeyboard';
import { useOverseerSession } from './hooks/useOverseerSession';
import { useSavedViews } from './hooks/useSavedViews';
import { useThreadsNeedsYouCount } from './hooks/useThreads';
import {
  type ActionFeedbackCache,
  withActionFeedback,
} from './lib/actionFeedback';
import type {
  GlobalView,
  ProjectView,
  SettingsPage,
  TaskTab,
} from './lib/appNav';
import { initialNavState, navReducer } from './lib/appNav';
import { hideArchivedRuns } from './lib/archiveFilter';
import { hasDispatchKey, launchRootKey } from './lib/bootWarm';
import type { InboxTarget } from './lib/inbox';
import { projectViewForInboxTarget, unreadCount } from './lib/inbox';
import { buildInbox } from './lib/inboxQueue';
import { liveCeilingsOf, spendToday } from './lib/liveSpend';
import { buildPaletteEntries, docHitEntries } from './lib/paletteEntries';
import { PALETTE_SECTION_CAPS } from './lib/paletteSections';
import { basename } from './lib/projectName';
import { prNumberFromUrl } from './lib/reviewTarget';
import { isTerminalRunState } from './lib/runState';
import { useStatusModelOf } from './lib/statusModel';
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
import { openRefWith } from './lib/threadSources';
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
import { OverseerView } from './views/OverseerView';
import { OverviewView } from './views/OverviewView';
import { PlansView } from './views/PlansView';
import { ProjectsView } from './views/ProjectsView';
import { PrReviewView } from './views/PrReviewView';
import { SessionsHubView } from './views/SessionsHubView';
import { SettingsView } from './views/SettingsView';
import { TerminalsView } from './views/TerminalsView';
import { ThreadsView } from './views/ThreadsView';
import { cn } from '@/lib/utils';
import { PageHeaderShellContext } from '@/ui/ai/page-header';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/chrome';
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
// The Inbox's doc query: team docs whose head is conflicted.
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

function App() {
  const [navState, dispatchNav] = useReducer(navReducer, initialNavState);
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
  const onRunDispatched = useCallback((runId: string, taskId: string) => {
    dispatchNav({ type: 'openTask', taskId, tab: 'run', runId });
  }, []);

  const rawData = useDispatchProject(activeProject?.path ?? null, {
    selectedRunId: navState.activeRunId,
    onRunDispatched,
  });

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
  const focusedTaskId = navState.activeTaskId ?? navState.peekTaskId;
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
    rawData.config?.effort?.overseer
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

  useGlobalKeyboard({
    // `modalOpen` is computed inside the hook itself, via a live DOM check for any open
    // dialog — so SessionDetailModal/DiffModal mounted deep inside the Sessions hub also
    // suppress the global commands while open, the same as CreateTaskModal always did.
    onCommand: (command) => {
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
          threadView: data.messageAccess.canMessage
            ? (taskId) => (
                <TaskThreadTab
                  data={data}
                  taskId={taskId}
                  onOpenRef={openRef}
                  onOpenOverseer={() => setGlobalView('overseer')}
                />
              )
            : undefined,
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

  const paletteEntries = useMemo(
    () =>
      buildPaletteEntries({
        hasProject: activeProject !== null,
        views: PROJECT_NAV_VIEWS,
        tasks: paletteTasks,
        readyIds: paletteReadyIds,
        dev: import.meta.env.DEV,
        savedViews: savedViews.views,
        currentTaskId: navState.activeTaskId ?? navState.peekTaskId,
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
      openSavedView,
      copyTaskLink,
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
                          switcher={
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
                                import.meta.env.DEV
                                  ? () => setGlobalView('gallery')
                                  : undefined
                              }
                            />
                          }
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
                                onOpenOverseer={() => setGlobalView('overseer')}
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
                              {resolutionError !== null ? (
                                <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                                  <TriangleAlert className="text-destructive size-5" />
                                  <EmptyState
                                    message={resolutionError}
                                    className="p-0"
                                  />
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
                                      Add a local folder or clone a repository
                                      from GitHub to get started.
                                    </EmptyDescription>
                                  </EmptyHeader>
                                  <EmptyContent>
                                    <Button
                                      onClick={() => setAddProjectOpen(true)}
                                    >
                                      <Plus className="size-4" />
                                      Add project
                                    </Button>
                                  </EmptyContent>
                                </Empty>
                              ) : stillResolving ? (
                                <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                                  <Spinner className="text-muted-foreground size-5" />
                                  <EmptyState
                                    message="Loading project…"
                                    className="p-0"
                                  />
                                </div>
                              ) : showGetStarted ? (
                                <GetStartedView projectPath={root} />
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
                                      onSetShowArchived={data.setShowArchived}
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
                                      projectName={activeProject?.name ?? null}
                                      data={data}
                                      dispatchTask={cockpitDispatch}
                                      onDispatchFailed={onCockpitDispatchFailed}
                                      onOpenTask={openTaskView}
                                      onPeekTask={peekTask}
                                      onOpenLive={() =>
                                        selectProjectView('live')
                                      }
                                    />
                                  )}
                                  {navState.projectView === 'live' && (
                                    <LiveView
                                      projectName={activeProject?.name ?? null}
                                      data={data}
                                      dispatchTask={cockpitDispatch}
                                      onDispatchFailed={onCockpitDispatchFailed}
                                      onOpenTask={openTaskView}
                                      onPeekTask={peekTask}
                                    />
                                  )}
                                  {navState.projectView === 'overview' && (
                                    <OverviewView
                                      projectName={activeProject?.name ?? null}
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
                                      projectName={activeProject?.name ?? null}
                                      data={data}
                                      onOpenTask={openTaskView}
                                    />
                                  )}
                                  {navState.projectView === 'inbox' && (
                                    <InboxView
                                      projectName={activeProject?.name ?? null}
                                      projectRoot={activeProject?.path ?? null}
                                      data={inboxData}
                                      project={data}
                                      onOpenTask={openTaskView}
                                      onOpenPr={(number) =>
                                        dispatchNav({ type: 'openPr', number })
                                      }
                                      onOpenDoc={(id) => openDoc(id, null)}
                                    />
                                  )}
                                  {navState.projectView === 'threads' && (
                                    <ThreadsView
                                      data={data}
                                      projectName={activeProject?.name ?? null}
                                      focus={navState.threadFocus}
                                      onFocus={openThread}
                                      onOpenRef={openRef}
                                      overseer={{
                                        thread: overseer.record?.thread ?? null,
                                        busy:
                                          overseer.sending ||
                                          overseer.record?.state === 'running',
                                        submit: overseer.reply,
                                        open: () => setGlobalView('overseer'),
                                      }}
                                    />
                                  )}
                                  {navState.projectView === 'landing' && (
                                    <LandingTableView
                                      projectName={activeProject?.name ?? null}
                                      data={data}
                                      onOpenRun={(taskId, runId) =>
                                        openTaskView(taskId, 'review', runId)
                                      }
                                      onOpenPr={(number) =>
                                        dispatchNav({ type: 'openPr', number })
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
                                      projectName={activeProject?.name ?? null}
                                      key={
                                        navState.impactSubject === null
                                          ? 'impact-empty'
                                          : `${navState.impactSubject.kind}:${navState.impactSubject.id}`
                                      }
                                      data={data}
                                      initialSubject={navState.impactSubject}
                                    />
                                  )}
                                  {navState.projectView === 'board' && (
                                    <BoardView
                                      projectName={activeProject?.name ?? null}
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
                                      projectName={activeProject?.name ?? null}
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
                                      initialAnchor={navState.activeDocAnchor}
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
                                  {navState.projectView === 'brain-dump' && (
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
                          accessFor(data.myTier, data.attachedWithoutAppToken)
                            .canOperate
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
                          setGlobalView('settings', { page: 'integrations' })
                        }
                        onOpenOverseer={() => setGlobalView('overseer')}
                        presence={activeProject !== null ? data.presence : []}
                        taskTitle={(id) =>
                          data.tasksIncludingArchived.find(
                            (t) => t.meta.id === id
                          )?.meta.title
                        }
                      />

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

                      {navState.peekTaskId !== null && (
                        // Remount per task so per-task state (a picked run, an in-flight
                        // dispatch) never leaks across a peek re-pointed at another task.
                        <TaskPeekDialog
                          key={navState.peekTaskId}
                          taskId={navState.peekTaskId}
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
