import type { TaskDoc } from '@dispatch/core/browser';
import { useQuery } from '@tanstack/react-query';
import { Plus, TriangleAlert } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useState,
} from 'react';

import { accessFor } from './components/settings/access';
import { AddProjectDialog } from './components/shell/AddProjectDialog';
import { CommandPalette } from './components/shell/CommandPalette';
import {
  DeepLinkProvider,
  useCopyTaskLink,
} from './components/shell/DeepLinkContext';
import { ErrorBoundary } from './components/shell/ErrorBoundary';
import {
  FrameStatusStrip,
  type LiveCeilings,
} from './components/shell/FrameStatusStrip';
import { LiveRail } from './components/shell/LiveRail';
import {
  type NotificationInbox,
  NotificationInboxProvider,
} from './components/shell/NotificationInboxContext';
import { AlsoViewing } from './components/shell/PresenceStack';
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
import type { TaskDetailPanelProps } from './components/tasks/detail';
import { TaskPeekDialog } from './components/tasks/TaskPeekDialog';
import { useDataChangedEvents } from './hooks/useDataChangedEvents';
import { useDeepLinkRouter } from './hooks/useDeepLinkRouter';
import { useDispatchProject } from './hooks/useDispatchProject';
import { useGlobalKeyboard } from './hooks/useGlobalKeyboard';
import { useOverseerSession } from './hooks/useOverseerSession';
import { useSavedViews } from './hooks/useSavedViews';
import { withActionFeedback } from './lib/actionFeedback';
import type {
  GlobalView,
  ProjectView,
  SettingsPage,
  TaskTab,
} from './lib/appNav';
import { initialNavState, navReducer } from './lib/appNav';
import { hideArchivedRuns } from './lib/archiveFilter';
import type { InboxTarget } from './lib/inbox';
import { projectViewForInboxTarget, unreadCount } from './lib/inbox';
import { buildInbox } from './lib/inboxQueue';
import { isLinearConfigured } from './lib/linearSettings';
import { resolveExecuteModel } from './lib/models';
import { buildPaletteEntries } from './lib/paletteEntries';
import { basename } from './lib/projectName';
import { prNumberFromUrl } from './lib/reviewTarget';
import { isTerminalRunState } from './lib/runState';
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
import { checkForUpdate, installUpdateAndRelaunch } from './lib/updater';
import { applyZoomFactor, loadZoomFactor, stepZoomFactor } from './lib/zoom';
import { AllAgentsView } from './views/AllAgentsView';
import { BoardView } from './views/BoardView';
import { BrainDumpView } from './views/BrainDumpView';
import { BranchesView } from './views/BranchesView';
import { DesignView } from './views/DesignView';
import { DraftView } from './views/DraftView';
import { FilesView } from './views/FilesView';
import { FirstRunView } from './views/FirstRunView';
import { GalleryView } from './views/GalleryView';
import { GetStartedView } from './views/GetStartedView';
import { ImpactView } from './views/ImpactView';
import { InboxView } from './views/InboxView';
import { LandingTableView } from './views/LandingTableView';
import type { FocusEpicRequest } from './views/MilestonesView';
import { OverseerView } from './views/OverseerView';
import { OverviewView } from './views/OverviewView';
import { PlansView } from './views/PlansView';
import { PrReviewView } from './views/PrReviewView';
import { SessionsHubView } from './views/SessionsHubView';
import { SettingsView } from './views/SettingsView';
import { TaskView } from './views/TaskView';
import { TerminalsView } from './views/TerminalsView';
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
    queryKey: ['current-project-root'],
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
    queryKey: ['has-dispatch', root],
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
  // now, and a run that has just been created is live, so it opens on Chat.
  const onRunDispatched = useCallback((runId: string, taskId: string) => {
    dispatchNav({ type: 'openTask', taskId, tab: 'chat', runId });
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
  const data = useMemo(
    () =>
      withActionFeedback(
        rawData,
        (action, message) =>
          toasts.push({
            title: `${action} failed`,
            description: message,
            tone: 'error',
          }),
        (message, taskId) =>
          toasts.push({
            title: message,
            tone: 'success',
            ...(taskId !== undefined && {
              description: taskToastDescription(
                taskId,
                rawData.tasks.find((t) => t.meta.id === taskId)?.meta.title ??
                  taskId
              ),
              link: viewTaskLink(taskId, (id) =>
                dispatchNav({
                  type: 'openTask',
                  taskId: id,
                  tab: 'details',
                  runId: rawData.latestRunByTaskId.get(id)?.id ?? null,
                })
              ),
            }),
          })
      ),
    [rawData, toasts]
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
  // run so Chat/Diff have something to show immediately.
  const openTaskView = useCallback(
    (taskId: string, tab: TaskTab = 'details', runId?: string) => {
      const resolved =
        runId ?? rawData.latestRunByTaskId.get(taskId)?.id ?? null;
      dispatchNav({ type: 'openTask', taskId, tab, runId: resolved });
    },
    [rawData.latestRunByTaskId]
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
        isTerminalRunState(run.state) ? 'diff' : 'chat',
        run.id
      );
    },
    [rawData.runs, openTaskView]
  );

  // Every non-terminal run for this project — the "Agents" view's list and the sidebar's live
  // badge both read from this single project's own run list now, not a cross-project fan-out
  // of N daemons (the old `useAllAgents`, removed with this pivot).
  // Everything spent today across this project's runs. Summed from RunMeta.costUsd, which the
  // executor stamps once a run finishes — so this is settled spend, not an estimate of work in
  // flight. `null` when nothing has cost anything yet, which hides the readout entirely.
  const todaySpend = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const total = data.runs.reduce((sum, r) => {
      if (r.costUsd === undefined) return sum;
      return new Date(r.updatedAt) >= start ? sum + r.costUsd : sum;
    }, 0);
    return total > 0 ? total : null;
  }, [data.runs]);

  const liveRuns = useMemo(
    () => data.runs.filter((run) => !isTerminalRunState(run.state)),
    [data.runs]
  );

  // The live fan-outs summed for the status strip: settled spend across them and their
  // spend ceilings added up — `null` ceilings when no live session set one.
  const liveCeilings = useMemo<LiveCeilings | null>(() => {
    const sessions = data.liveEpicSessions;
    if (sessions.length === 0) return null;
    let settledUsd = 0;
    let ceilingUsd: number | null = null;
    for (const progress of sessions) {
      settledUsd += progress.spend.settledUsd;
      const ceiling = progress.session?.maxSpendUsd ?? null;
      if (ceiling !== null) ceilingUsd = (ceilingUsd ?? 0) + ceiling;
    }
    return { live: sessions.length, settledUsd, ceilingUsd };
  }, [data.liveEpicSessions]);

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
        fixLoops: data.fixLoops,
        me: data.me,
      }),
    [
      data.runs,
      data.tasks,
      data.epics,
      data.repoPrs,
      data.me,
      data.mergeQueue,
      data.pendingApprovals,
      data.openQuestions,
      data.fixLoops,
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
      else if (command === 'goto-inbox') selectProjectView('inbox');
      else if (command === 'goto-tasks') selectProjectView('board');
      else if (command === 'goto-control-room') selectProjectView('overview');
      else if (command.startsWith('goto-')) {
        // Position in the rail, not an id — ⌘1 is the first row, and so on.
        const view = PROJECT_VIEW_ORDER[Number(command.slice(5)) - 1];
        if (view !== undefined) selectProjectView(view);
      }
    },
  });

  // Resolved from the archived-inclusive list: an archived task's Board card or List row
  // must still open its detail dialog when the Archived toggle is on.
  const selectedDoc =
    navState.peekTaskId !== null
      ? (data.tasksIncludingArchived.find(
          (t) => t.meta.id === navState.peekTaskId
        ) ?? null)
      : null;

  // The task the full task view is showing, resolved the same way as `selectedDoc` — `null`
  // once a task has been deleted/archived out from under an open view.
  const activeTaskDoc =
    navState.activeTaskId !== null
      ? (data.tasksIncludingArchived.find(
          (t) => t.meta.id === navState.activeTaskId
        ) ?? null)
      : null;

  // Local consts so narrowing survives the closure (TaskDetailPanel has no `data` prop).
  // Raw `sendPlanMessage`, not the `data.` wrapper, which answers a different plan slot.
  const enrichPlanRecord = data.enrichPlanRecord;
  const enrichClient = data.client;
  const onAnswerEnrich =
    enrichClient !== null && enrichPlanRecord !== undefined
      ? async (message: string) => {
          await enrichClient.sendPlanMessage(enrichPlanRecord.id, message);
        }
      : undefined;

  // The shared `TaskDetailPanel` prop bundle for one task, used by both the peek dialog and
  // the full task view so the two mounts render identically. Callers only invoke this once
  // `data.config` has loaded (both call sites already gate on that), so a still-loading
  // config is a caller bug rather than a state this needs to render around.
  const buildTaskPanelProps = (doc: TaskDoc): TaskDetailPanelProps => {
    if (data.config === null) {
      throw new Error('buildTaskPanelProps requires a loaded project config');
    }
    return {
      doc,
      defaultModel: resolveExecuteModel(data.config),
      defaultEffort: data.config.effort?.execute,
      executors: data.executors ?? undefined,
      statuses: data.config.statuses,
      ready: data.readyIds.has(doc.meta.id),
      run: data.latestRunByTaskId.get(doc.meta.id),
      runs: data.runs.filter((r) => r.taskId === doc.meta.id),
      epics: data.epics,
      tasks: data.tasksIncludingArchived,
      latestRunByTaskId: data.latestRunByTaskId,
      onUpdate: data.handleUpdate,
      onMoveStatus: data.moveTaskStatus,
      onDispatch: data.handleDispatch,
      onEnrich: data.handleEnrichTask,
      // The slot is app-level so a draft survives closing the peek; only hand it over when
      // it belongs to the task being shown.
      enrichPlan:
        data.enrichTaskId === doc.meta.id ? data.enrichPlanRecord : undefined,
      onDismissEnrich: data.handleDismissEnrich,
      onAnswerEnrich,
      onOpenSession: (runId) => openTaskView(doc.meta.id, 'chat', runId),
      onOpenTask: (taskId) => dispatchNav({ type: 'openPeek', taskId }),
      linearLinks: data.linearLinks,
      linearConfigured: isLinearConfigured(data.linearStatus),
      onPushToLinear: (taskId) => data.handleSyncLinear([taskId]),
      client: data.client,
      port: data.port,
      fixLoopEscalation: data.config.fixLoop.escalation,
      headerTrailing: (
        <AlsoViewing
          viewers={data.presence.filter(
            (p) => p.viewing === doc.meta.id && p.ref !== data.me
          )}
        />
      ),
    };
  };

  // The draft the draft view is showing, resolved from nav state — `null` when the id
  // points at a draft that has since been dismissed or evicted.
  const activeDraft =
    navState.activeDraftId !== null
      ? (data.drafts.find((d) => d.id === navState.activeDraftId) ?? null)
      : null;

  // Destructured to bare locals rather than referenced as `data.tasks`/`data.readyIds`/
  // `data.handleDispatch` inside the memo below: `data` itself is a brand-new object literal
  // every render (it's returned fresh from `useDispatchProject` each time), so
  // `react-hooks/exhaustive-deps` correctly refuses to accept a `data.X` member expression in
  // the dependency array in place of the whole (unstable) `data` — these three fields/
  // handlers are independently stable (state values, or `useCallback`-memoized), so binding
  // them to their own names lets the array list exactly what changes.
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
  // rather than an empty Control room. Gated on `overview` — the view it lands
  // on — so navigating anywhere deliberately leaves the first run behind
  // instead of trapping someone who came to look around. Archived tasks count:
  // a board someone emptied is not a fresh project.
  const showFirstRun =
    navState.section === 'project' &&
    navState.projectView === 'overview' &&
    data.tasksReady &&
    data.tasksIncludingArchived.length === 0;

  return (
    <TooltipProvider>
      <ShellActionsProvider value={shellActions}>
        <NotificationInboxProvider value={notificationInboxValue}>
          <DeepLinkProvider value={deepLinkActions}>
            <SavedViewsProvider value={savedViews}>
              <PageHeaderShellContext.Provider value={pageHeaderShell}>
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
                      onOpenPalette={() => dispatchNav({ type: 'openPalette' })}
                      onNewTask={() => openCreateTask()}
                      inboxCount={inboxData.total}
                      overseerPendingCount={
                        (overseer.record?.pendingActions.length ?? 0) +
                        (overseer.record?.pendingApprovals.length ?? 0)
                      }
                      liveAgentCount={liveRuns.length}
                      drafts={data.drafts}
                      onOpenDraft={(draftId) =>
                        dispatchNav({ type: 'openDraft', draftId })
                      }
                      onDismissDraft={(id) => void data.handleDismissDraft(id)}
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
                                  Add a local folder or clone a repository from
                                  GitHub to get started.
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
                                    void data.handleArchiveRun(runId, archived)
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
                                <OverseerView data={data} overseer={overseer} />
                              )}
                              {navState.globalView === 'settings' && (
                                <SettingsView
                                  activeProject={activeProject}
                                  data={settingsData}
                                  initialPage={
                                    navState.settingsPage ?? 'general'
                                  }
                                  onOpenTask={(taskId) =>
                                    openTaskView(taskId, 'details')
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
                              {navState.projectView === 'overview' && (
                                <OverviewView
                                  projectName={activeProject?.name ?? null}
                                  data={data}
                                  onOpenTask={(taskId) =>
                                    dispatchNav({ type: 'openPeek', taskId })
                                  }
                                  onOpenRun={jumpToRun}
                                  onReviewRun={(runId) => {
                                    const run = data.runs.find(
                                      (r) => r.id === runId
                                    );
                                    if (run !== undefined) {
                                      openTaskView(run.taskId, 'diff', run.id);
                                    }
                                  }}
                                  onGoToBoard={() => selectProjectView('board')}
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
                                />
                              )}
                              {navState.projectView === 'landing' && (
                                <LandingTableView
                                  projectName={activeProject?.name ?? null}
                                  data={data}
                                  onOpenRun={(taskId, runId) =>
                                    openTaskView(taskId, 'diff', runId)
                                  }
                                  onOpenPr={(number) =>
                                    dispatchNav({ type: 'openPr', number })
                                  }
                                />
                              )}
                              {navState.projectView === 'pr' &&
                                navState.activePrNumber !== null && (
                                  <PrReviewView
                                    projectName={activeProject?.name ?? null}
                                    key={navState.activePrNumber}
                                    data={data}
                                    prNumber={navState.activePrNumber}
                                    onBack={() => dispatchNav({ type: 'back' })}
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
                                  onSelectTask={(taskId, tab, runId) => {
                                    // A phase drill from the milestones layout names its
                                    // tab; a plain row click keeps the peek.
                                    if (tab !== undefined)
                                      openTaskView(taskId, tab, runId);
                                    else
                                      dispatchNav({ type: 'openPeek', taskId });
                                  }}
                                  onNewTask={(status) =>
                                    openCreateTask(
                                      status !== undefined
                                        ? { status }
                                        : undefined
                                    )
                                  }
                                  onPlanWork={() => selectProjectView('plans')}
                                />
                              )}
                              {navState.projectView === 'task' &&
                                navState.activeTaskId !== null &&
                                data.config !== null && (
                                  <TaskView
                                    projectName={activeProject?.name ?? null}
                                    key={navState.activeTaskId}
                                    data={data}
                                    taskId={navState.activeTaskId}
                                    tab={navState.taskTab}
                                    activeRunId={navState.activeRunId}
                                    onSetTab={(tab) =>
                                      dispatchNav({ type: 'setTaskTab', tab })
                                    }
                                    onSelectRun={(runId) =>
                                      openTaskView(
                                        navState.activeTaskId,
                                        navState.taskTab,
                                        runId
                                      )
                                    }
                                    onBack={() => dispatchNav({ type: 'back' })}
                                    // `undefined` when the task has gone away (deleted/archived out from
                                    // under an open view) — TaskView's own lookup finds the same absence
                                    // and renders its "no longer available" state before ever touching
                                    // this prop.
                                    panelProps={
                                      activeTaskDoc !== null
                                        ? buildTaskPanelProps(activeTaskDoc)
                                        : undefined
                                    }
                                    onViewPr={(runId) => {
                                      const number = prNumberFromUrl(
                                        data.runs.find((r) => r.id === runId)
                                          ?.prUrl
                                      );
                                      if (number !== null) {
                                        dispatchNav({ type: 'openPr', number });
                                      }
                                    }}
                                    onOpenImpact={(subject) =>
                                      dispatchNav({
                                        type: 'openImpact',
                                        subject,
                                      })
                                    }
                                  />
                                )}
                              {navState.projectView === 'branches' && (
                                <BranchesView
                                  projectName={activeProject?.name ?? null}
                                  data={data}
                                  onOpenRun={jumpToRun}
                                  onOpenImpact={(subject) =>
                                    dispatchNav({ type: 'openImpact', subject })
                                  }
                                />
                              )}
                              {navState.projectView === 'design' && (
                                <DesignView data={data} />
                              )}
                              {navState.projectView === 'files' && (
                                <FilesView data={data} />
                              )}
                              {navState.projectView === 'terminals' && (
                                <TerminalsView data={data} />
                              )}
                              {navState.projectView === 'brain-dump' && (
                                <BrainDumpView
                                  data={data}
                                  onOpenTask={(taskId) =>
                                    dispatchNav({ type: 'openPeek', taskId })
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
                                  onGoToBoard={() => selectProjectView('board')}
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
                                    onDone={() => selectProjectView('board')}
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
                    syncStatus={activeProject !== null ? data.syncStatus : null}
                    // autoCommit is an operator-only key, so only the owner is offered it.
                    onDisableAutoCommit={
                      accessFor(data.myTier, data.attachedWithoutAppToken)
                        .canOperate
                        ? () =>
                            void data.handleUpdateConfig({ autoCommit: false })
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
                      data.tasksIncludingArchived.find((t) => t.meta.id === id)
                        ?.meta.title
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

                  {selectedDoc !== null && data.config !== null && (
                    // Remount per task so per-task state (model choice, in-flight dispatch) can't leak across stack-rail navigation.
                    <TaskPeekDialog
                      projectName={activeProject?.name ?? null}
                      key={selectedDoc.meta.id}
                      {...buildTaskPanelProps(selectedDoc)}
                      onClose={() => dispatchNav({ type: 'closePeek' })}
                      onExpand={() => openTaskView(selectedDoc.meta.id)}
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
                      onQuickAdd={() => {
                        setAiComposerOpen(false);
                        openQuickAddTask(createPreset ?? undefined);
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
                  />
                </div>
              </PageHeaderShellContext.Provider>
            </SavedViewsProvider>
          </DeepLinkProvider>
        </NotificationInboxProvider>
      </ShellActionsProvider>
    </TooltipProvider>
  );
}

export default App;
