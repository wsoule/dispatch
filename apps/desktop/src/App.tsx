import {
  type CreateInput,
  providerById,
  type TaskListItem,
} from '@dispatch-foo/core/browser';
import type { DraftRecord } from '@dispatch/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Coins, TriangleAlert } from 'lucide-react';
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
import { CapturedNotes } from './components/chat/CapturedNotes';
import { ForYouPosts } from './components/chat/ForYouPosts';
import { TasksComposer } from './components/chat/TasksComposer';
import { ConversationTimeline } from './components/conversation/ConversationTimeline';
import {
  RoomHome,
  TaskConversationHome,
} from './components/conversation/Homes';
import { askAgentToFix } from './components/failure/FailureNotice';
import {
  type FlightPlanHost,
  FlightPlanHostContext,
} from './components/flightplan/ContainerFlightPlanSection';
import { FirstTaskGuide } from './components/guide/FirstTaskGuide';
import type {
  SendChoice,
  SendToAgentOptions,
} from './components/guide/SendToAgent';
import { MemoryRecent } from './components/memory/MemoryRecent';
import {
  DraftsSection,
  NotificationsSection,
} from './components/overseer/InflowSections';
import { OutsidePeek } from './components/peek/OutsidePeek';
import { PersonPeek } from './components/peek/PersonPeek';
import { ThreadPeek } from './components/peek/ThreadPeek';
import { PeopleProvider } from './components/people/PeopleContext';
import { OverseerGrantsGroup } from './components/settings/OverseerGrantsGroup';
import { AgentStep } from './components/setup/AgentStep';
import { SetupBanner } from './components/setup/SetupBanner';
import { AddProjectDialog } from './components/shell/AddProjectDialog';
import { CommandPalette } from './components/shell/CommandPalette';
import { DaemonUnavailable } from './components/shell/DaemonUnavailable';
import {
  DeepLinkProvider,
  useCopyTaskLink,
} from './components/shell/DeepLinkContext';
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
import { useAdminItems } from './hooks/useAdminItems';
import { useDataChangedEvents } from './hooks/useDataChangedEvents';
import { useDeepLinkRouter } from './hooks/useDeepLinkRouter';
import { useDispatchProject } from './hooks/useDispatchProject';
import {
  useFirstTaskGuide,
  useFreshEmptyProject,
} from './hooks/useFirstTaskGuide';
import { useGlobalKeyboard } from './hooks/useGlobalKeyboard';
import { useOverseerSession } from './hooks/useOverseerSession';
import { useSavedViews } from './hooks/useSavedViews';
import { useSidePanelNotifications } from './hooks/useSidePanelNotifications';
import { tasksKey } from './hooks/useTaskDoc';
import {
  threadListsKey,
  useA2APeers,
  useChannels,
  useMailbox,
} from './hooks/useThreads';
import { useTrafficLightInset } from './hooks/useTrafficLightInset';
import {
  type ActionFeedbackCache,
  describeError,
  withActionFeedback,
} from './lib/actionFeedback';
import { orbLabel, orbState, overseerTurnLive } from './lib/agentPresence';
import { overseerOf } from './lib/agentRoster';
import {
  type GlobalView,
  HOST_VIEWS,
  type ProjectView,
  type SettingsPage,
  type TaskTab,
} from './lib/appNav';
import { hideArchivedRuns } from './lib/archiveFilter';
import { hasDispatchKey, launchRootKey } from './lib/bootWarm';
import { openCaptures } from './lib/capturedNotes';
import { dispatchConfigKey } from './lib/configEvents';
import { mentions, subjectOf } from './lib/conversationScope';
import { type DecisionItem, decisionTarget } from './lib/decisionFeed';
import { draftTrayViewModel } from './lib/draftTray';
import { formTaskInput, guideProvider } from './lib/firstTaskGuide';
import {
  dismissPosts,
  readDismissedPosts,
  visiblePosts,
  writeDismissedPosts,
} from './lib/forYouDismissed';
import type { InboxEntry, InboxTarget } from './lib/inbox';
import { projectViewForInboxTarget, unreadCount } from './lib/inbox';
import { liveCeilingsOf, spendToday } from './lib/liveSpend';
import { countMergeReady } from './lib/mergeReady';
import { resolveExecuteModel } from './lib/models';
import { awayDigest } from './lib/narrator';
import { needsYou } from './lib/needsYou';
import type { OverseerDoor } from './lib/overseerThread';
import {
  addressEntries,
  buildPaletteEntries,
  docHitEntries,
} from './lib/paletteEntries';
import { PALETTE_SECTION_CAPS } from './lib/paletteSections';
import { buildPosts, type Post, questionToAnswer } from './lib/posts';
import { basename } from './lib/projectName';
import { prNumberFromUrl } from './lib/reviewTarget';
import { isTerminalRunState } from './lib/runState';
import {
  autoCompleteAction,
  readSetupComplete,
  SETUP_REPORT_STALE_MS,
  setupReportKey,
  writeSetupComplete,
} from './lib/setupState';
import { useStatusModelOf } from './lib/statusModel';
import { computeBlockedIds } from './lib/taskGraph';
import { itemBucket, queuedTaskIds, taskStatusCounts } from './lib/taskStatus';
import {
  addProject,
  currentProjectRoot,
  ensureDispatchd,
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
  twoViewsKeyAction,
} from './lib/twoViews';
import { checkForUpdate, installUpdateAndRelaunch } from './lib/updater';
import { applyZoomFactor, loadZoomFactor, stepZoomFactor } from './lib/zoom';
import { AllAgentsView } from './views/AllAgentsView';
import { DocsView } from './views/DocsView';
import { DraftView } from './views/DraftView';
import { FilesView } from './views/FilesView';
import { FirstRunView } from './views/FirstRunView';
import { OverseerFocusView } from './views/OverseerFocusView';
import { PrReviewView } from './views/PrReviewView';
import { SessionsHubView } from './views/SessionsHubView';
import type { HostedSettingsPage } from './views/SettingsView';
import { SetupView } from './views/SetupView';
import { type TasksSidePage, TasksView } from './views/TasksView';
import { TerminalsView } from './views/TerminalsView';
import { ThreadsView } from './views/ThreadsView';
import { type OverseerFocus, TwoViewOverseer } from './views/TwoViewOverseer';
import { PageHeaderShellContext } from '@/ui/ai/page-header';
import { EmptyState, SectionLabel } from '@/ui/chrome';
import { Spinner } from '@/ui/spinner';
import { TooltipProvider } from '@/ui/tooltip';

// The hosts a task page and a Flight Plan draw from, provided together so the shell's
// provider stack stays one level deep.
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

// There is no sidebar to toggle, and the top bar owns the drag region.
const TWO_VIEWS_PAGE_HEADER = {
  sidebarHidden: false,
  onToggleSidebar: () => {},
  trafficLightInset: false,
  dragRegion: false,
};

function App() {
  const queryClient = useQueryClient();
  const [{ nav: navState, twoViews: twoViewsState }, dispatchNav] = useReducer(
    appNavReducer,
    initialAppNavState
  );
  const [showCreate, setShowCreate] = useState(false);
  // What a board column's or list group's "+" pre-fills into the creator (status today;
  // milestone/milestone once the creator reads them); `null` leaves every field to its default.
  const [createPreset, setCreatePreset] = useState<CreateTaskPreset | null>(
    null
  );
  // The AI task composer, a dialog rather than a screen — open state lives here (not in
  // `navState`) so it renders on top of whatever view is underneath instead of replacing it.
  const [aiComposerOpen, setAiComposerOpen] = useState(false);

  // Whether the top bar clears the macOS traffic lights.
  const trafficLightInset = useTrafficLightInset();

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
                description: describeError(err),
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
  // time. `overrideRoot` (set by the project switcher) wins over the launch
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
      return normalized;
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
  // marker, not a switcher target.
  useEffect(() => {
    if (activeProject === null || navState.activeProjectId !== null) return;
    dispatchNav({ type: 'selectProject', projectId: activeProject.path });
  }, [activeProject, navState.activeProjectId]);

  const selectProjectView = useCallback((view: ProjectView) => {
    dispatchNav({ type: 'setProjectView', view });
  }, []);

  // `page` lands Settings on one of its pages; `g s` and the switcher's gear leave it to
  // the last page.
  const setGlobalView = useCallback(
    (view: GlobalView, options?: { page?: SettingsPage }) => {
      dispatchNav({ type: 'setGlobalView', view, page: options?.page });
    },
    []
  );

  // Opens the task creator, optionally pre-filled — the single entry point every "New
  // task"/"+" affordance (a board column's or list group's hover "+", the palette action,
  // the global `c` shortcut) calls through, so the creator's preset is
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
  const focusedTaskId = twoViewsTaskId;
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
  // A board drag's status change is not a `handle*`, so it reports its own
  // refusal (a 409 while this machine lacks the team's key, say).
  const rawMoveTaskStatus = rawData.moveTaskStatus;
  const moveTaskStatus = useCallback(
    (id: string, status: string): Promise<void> =>
      rawMoveTaskStatus(id, status).catch((err: unknown) => {
        feedback.onError('Change status', describeError(err));
      }),
    [rawMoveTaskStatus, feedback]
  );
  const data = useMemo(
    () => ({
      ...withActionFeedback(
        rawData,
        feedback.onError,
        feedback.onSuccess,
        feedback.cache
      ),
      moveTaskStatus,
    }),
    [rawData, feedback, moveTaskStatus]
  );
  // Settings reports its own save failures (its save line, a refusal's reason,
  // a kept draft), which the toast wrapper above would swallow first.
  const settingsData = useMemo(
    () => ({ ...data, handleUpdateConfig: rawData.handleUpdateConfig }),
    [data, rawData.handleUpdateConfig]
  );

  // The overseer chat's session — mounted here, not inside the Overseer view, so the
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
    true
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
        openFile: (path) => dispatchNav({ type: 'tv/openFile', path }),
        openDoc,
      }),
    [openTaskView, openDoc]
  );
  const openThread = useCallback(
    (messageId: string | null) =>
      dispatchNav({ type: 'openThread', messageId }),
    []
  );

  // The project's saved views and favorites, one instance shared through
  // `SavedViewsProvider` by the Tasks header's tabs and the task page's star.
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

  // Everything spent today across this project's runs; `null` hides the readout.
  const todaySpend = useMemo(() => spendToday(data.runs), [data.runs]);

  const liveRuns = useMemo(
    () => data.runs.filter((run) => !isTerminalRunState(run.state)),
    [data.runs]
  );

  // The live fan-outs summed for the status strip: settled spend across them and their
  // spend ceilings added up — `null` ceilings when no live session set one.
  const liveCeilings = useMemo(
    () => liveCeilingsOf(data.liveMilestoneSessions),
    [data.liveMilestoneSessions]
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

  const statusModel = useStatusModelOf(data.config);

  // Finished runs "Merge all ready" would queue: Going out's Landing action.
  const mergeReadyCount = useMemo(() => {
    const queued = new Set(
      (data.mergeQueue?.entries ?? []).map((e) => e.runId)
    );
    return countMergeReady(
      data.runs,
      data.tasksIncludingArchived,
      queued,
      statusModel
    );
  }, [data.runs, data.tasksIncludingArchived, data.mergeQueue, statusModel]);

  // One set of numbers: the orb, "tasks ●" and the Needs you header all read `needs.count`.
  const mailbox = useMailbox(
    data.client,
    data.port,
    data.me,
    data.messageAccess.canMessage
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
  const narrator = useNarratorSince(activeProject?.path ?? null);
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
    () => ({ bucketOf, starred: starredTaskIds, me: data.me }),
    [bucketOf, starredTaskIds, data.me]
  );
  const admin = useAdminItems(data.client, data.port);
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
  // dialog. Gates ⌘D and the palette's "Drop a thought" alike.
  const quickCaptureAvailable = activeProject !== null && data.client !== null;
  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false);
  const openQuickCapture = useCallback(() => {
    if (quickCaptureAvailable) setQuickCaptureOpen(true);
  }, [quickCaptureAvailable]);

  const openShortcuts = useCallback(
    () => dispatchNav({ type: 'openShortcuts' }),
    []
  );

  useGlobalKeyboard({
    // `modalOpen` is computed inside the hook itself, via a live DOM check for any open
    // dialog — so SessionDetailModal/DiffModal mounted deep inside the Sessions hub also
    // suppress the global commands while open, the same as CreateTaskModal always did.
    onCommand: (command) => {
      // The `goto-*` keys and `[` resolve through `twoViewsKeyAction`.
      const action = twoViewsKeyAction(command);
      if (action !== null) {
        if (action !== 'swallow') dispatchNav(action);
        return;
      }
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
      else if (command === 'new-task') {
        if (activeProject !== null) openCreateTask();
      } else if (command === 'open-shortcuts') openShortcuts();
    },
  });

  // What every task page — the split pane, the peek, the full page — draws a
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
          // Docs need a teammate or app token, as the Docs view does.
          openDoc: data.messageAccess.canMessage ? openDoc : undefined,
          // Threads need the same token; without it the page shows no Thread tab.
          threadView: !data.messageAccess.canMessage
            ? undefined
            : (taskId) => (
                <TaskConversationHome
                  data={data}
                  taskId={taskId}
                  onOpenRef={openRef}
                />
              ),
          // The repo-wide Files and Terminals live on each run's page.
          showLessons: true,
          planOpensPages: true,
          compactPage: true,
          filesView: (runId: string) => <FilesView data={data} runId={runId} />,
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
        };

  // A list's or board's `d`: dispatch without following the run (it moves into In flight
  // in place), rejecting on failure so the caller can roll its optimistic move back.
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

  // Destructured to bare locals rather than referenced as `data.tasks`/`data.readyIds`/
  // `data.handleDispatch` inside the memo below: `data` changes whenever any of its fields
  // does, so depending on it whole would recompute on unrelated changes — binding the fields
  // this reads to their own names lets the array list exactly what matters.
  const {
    tasks: paletteTasks,
    readyIds: paletteReadyIds,
    handleDispatch,
    notificationInbox,
    markNotificationInboxRead,
    markNotificationRead,
    dismissNotification,
    clearNotifications,
  } = data;
  const [sidePanelNotifications, setSidePanelNotifications] =
    useSidePanelNotifications();

  // Every label in use across the project — the create dialog's Labels picker candidates.
  const labelCatalogue = useMemo(() => {
    const labels = new Set<string>();
    for (const doc of paletteTasks)
      for (const l of doc.meta.labels) labels.add(l);
    return [...labels].sort((a, b) => a.localeCompare(b));
  }, [paletteTasks]);

  // Opens the Tasks list on one saved view, from the palette's `Open view …` rows;
  // the list's header applies the selected view.
  const openSavedView = useCallback(
    (id: string) => {
      selectProjectView('board');
      savedViews.selectView(id);
    },
    [selectProjectView, savedViews]
  );

  // Click-through for a notification row that is not a task or run: a target that names a
  // page routes via `projectViewForInboxTarget`. Marks the whole inbox read too, so a fresh
  // unread count does not linger after the user just acted on it.
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
      if (target.kind === 'plan') {
        dispatchNav({ type: 'tv/showOverseer' });
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

  const peekTask = useCallback(
    (taskId: string) => dispatchNav({ type: 'openPeek', taskId }),
    []
  );

  // What a `<ContainerFlightPlanSection>` draws a plan with: the project's data and the
  // stay-in-place dispatch.
  // Plans' "Create & send agents…": the milestone's Plan tab opens Send agents once.
  const [sendAgents, setSendAgents] = useState<{
    milestoneId: string;
    nonce: number;
  } | null>(null);
  const onSendAgentsServed = useCallback(
    (nonce: number) =>
      setSendAgents((prev) => (prev?.nonce === nonce ? null : prev)),
    []
  );
  const flightPlanHost = useMemo<FlightPlanHost>(
    () => ({
      data,
      dispatchTask: cockpitDispatch,
      onDispatchFailed: onCockpitDispatchFailed,
      onOpenTask: openTaskView,
      onPeekTask: peekTask,
      sendAgents,
      onSendAgentsServed,
    }),
    [
      data,
      cockpitDispatch,
      onCockpitDispatchFailed,
      openTaskView,
      peekTask,
      sendAgents,
      onSendAgentsServed,
    ]
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
            description: describeError(err),
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
      openOverseer,
      selectProjectView,
      setGlobalView,
      openShortcuts,
      copyTaskId,
    ]
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
    data.messageAccess.canMessage
  );
  const palettePeers = useA2APeers(data.client, data.messageAccess.canMessage);
  // A teammate below the operator tier never gets Terminals or Design: the
  // daemon would 403 both. The palette and the hosted pages agree.
  const hideHostViews = isTeamLocalPage() && data.myTier !== 'operator';
  // The guide is set up further down (it needs Setup's state); the palette calls through this.
  const restartGuideRef = useRef<() => void>(() => {});
  const paletteEntries = useMemo(
    () => [
      ...buildPaletteEntries({
        hasProject: activeProject !== null,
        tasks: paletteTasks,
        readyIds: paletteReadyIds,
        savedViews: savedViews.views,
        currentTaskId: twoViewsTaskId,
        hideHostViews,
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
          openShortcuts,
          openSavedView,
          copyTaskLink,
          restartGuide: () => restartGuideRef.current(),
        },
      }),
      ...addressEntries({
        people: data.people,
        rooms: paletteRooms.map((room) => room.name),
        peers: palettePeers,
        me: data.me,
        open: (address) => dispatchNav({ type: 'tv/openAddress', address }),
      }),
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
      openShortcuts,
      savedViews.views,
      twoViewsTaskId,
      openSavedView,
      copyTaskLink,
      hideHostViews,
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
  // An empty project's Overseer opens on the first-run prompt box until it is
  // set aside for a conversation, for this project only. Archived tasks count:
  // a board someone emptied is not a fresh project.
  const [firstRunSetAsideFor, setFirstRunSetAsideFor] = useState<string | null>(
    null
  );
  const twoViewsFirstRun =
    activeProject !== null &&
    firstRunSetAsideFor !== activeProject.path &&
    data.tasksReady &&
    data.tasksIncludingArchived.length === 0;

  // Resolution, first-project and get-started screens take precedence over any view.
  const gateScreen: ReactNode =
    resolutionError !== null ? (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <TriangleAlert className="text-destructive size-5" />
        <EmptyState message={resolutionError} className="p-0" />
      </div>
    ) : noProjectYet || showGetStarted ? (
      <SetupView
        projectPath={showGetStarted ? root : null}
        onProjectChosen={async (path) => {
          const normalized = await handleAddProject(path);
          await ensureDispatchd(normalized);
          await queryClient.invalidateQueries({
            queryKey: hasDispatchKey(normalized),
          });
        }}
      />
    ) : stillResolving ? (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <Spinner className="text-muted-foreground size-5" />
        <EmptyState message="Loading project…" className="p-0" />
      </div>
    ) : null;

  const [setupComplete, setSetupComplete] = useState(readSetupComplete);
  // First run on this machine: once the project is up, check the agent. Completes
  // silently when nothing needs attention (an equipped developer sees nothing).
  const setupClient = data.client;
  const { data: setupReport } = useQuery({
    queryKey: setupReportKey(data.port),
    queryFn: () => {
      if (setupClient === null) throw new Error('dispatchd client not ready');
      return setupClient.fetchSetup();
    },
    enabled: !setupComplete && setupClient !== null && gateScreen === null,
    staleTime: SETUP_REPORT_STALE_MS,
  });
  // Background re-check once setup is done (signed out later, etc.). Shares the
  // report key but never feeds the first-run decision below.
  const { data: setupBannerReport } = useQuery({
    queryKey: setupReportKey(data.port),
    queryFn: () => {
      if (setupClient === null) throw new Error('dispatchd client not ready');
      return setupClient.fetchSetup();
    },
    enabled: setupComplete && setupClient !== null,
    staleTime: SETUP_REPORT_STALE_MS,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
  // Saves `executor` as the default agent and refetches what reads the default.
  // Callers refresh the daemon's agents first so a newly installed one is known.
  const saveDefaultAgent = useCallback(
    async (executor: string) => {
      if (setupClient === null) throw new Error('dispatchd client not ready');
      await setupClient.updateConfig({ executor });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: dispatchConfigKey(data.port),
        }),
        queryClient.invalidateQueries({
          queryKey: ['dispatch-executors', data.port],
        }),
      ]);
    },
    [setupClient, queryClient, data.port]
  );
  // Decided once, from the first report (and the config it's judged against): later
  // reports (after an install or sign-in) must not dismiss Setup before the chosen
  // agent is saved.
  const [setupShown, setSetupShown] = useState(false);
  const setupDecided = useRef(false);
  const configuredExecutor =
    data.config?.orchestrator.executor ?? data.executors?.default;
  useEffect(() => {
    if (
      setupReport === undefined ||
      configuredExecutor === undefined ||
      setupDecided.current
    )
      return;
    setupDecided.current = true;
    const action = autoCompleteAction(setupReport, configuredExecutor);
    if (!action.complete) {
      setSetupShown(true);
      return;
    }
    const finish = () => {
      writeSetupComplete();
      setSetupComplete(true);
    };
    if (action.setDefault === undefined) return finish();
    // A failed save shows Setup instead, so the agent gets picked by hand.
    const fallback = action.setDefault;
    (async () => {
      if (setupClient === null) throw new Error('dispatchd client not ready');
      await setupClient.refreshSetup();
      await saveDefaultAgent(fallback);
    })().then(finish, () => setSetupShown(true));
  }, [setupReport, configuredExecutor, saveDefaultAgent, setupClient]);
  const agentSetupScreen: ReactNode =
    !setupComplete &&
    gateScreen === null &&
    setupClient !== null &&
    setupShown ? (
      <SetupView
        projectPath={root ?? null}
        onProjectChosen={() => Promise.resolve()}
        agentStep={
          <AgentStep
            client={setupClient}
            port={data.port}
            onSetDefault={saveDefaultAgent}
            onContinue={() => {
              writeSetupComplete();
              setSetupComplete(true);
            }}
          />
        }
      />
    ) : null;

  // The first-task guide follows one task from a sentence to landed. It starts on a
  // fresh, empty project once Setup is done, and its progress lives in this browser.
  const projectEmpty = useFreshEmptyProject(activeProject?.path ?? null, {
    ready: data.tasksReady,
    count: data.tasksIncludingArchived.length,
    queryKey: tasksKey(data.port),
  });
  const guide = useFirstTaskGuide({
    projectPath: activeProject?.path ?? null,
    enabled: setupComplete && gateScreen === null && activeProject !== null,
    projectEmpty,
    drafts: data.drafts,
    tasks: data.tasksIncludingArchived,
    runs: data.runs,
  });
  const guideAgent = guideProvider(setupBannerReport, configuredExecutor);
  const sendOptions: SendToAgentOptions = {
    // The model list is Claude's, as DispatchCard decides it.
    modelChoice: configuredExecutor === 'claude',
    defaultModel: resolveExecuteModel(data.config),
    defaultEffort: data.config?.effort?.execute,
  };
  // The draft the first-run box started last, so its failure shows there after the box empties.
  const [firstRunDraftId, setFirstRunDraftId] = useState<string | null>(null);
  const firstRunDraft = data.drafts.find((d) => d.id === firstRunDraftId);
  const failedFirstRun =
    firstRunDraft?.state === 'failed' ? firstRunDraft : undefined;
  const guidePath = activeProject?.path ?? null;
  // The latest guide and project, for handlers that pick up again after an await.
  const guideRef = useRef(guide);
  const guidePathRef = useRef(guidePath);
  // The guide as it is now, or null once the project has changed since `path`.
  const guideFor = (path: string | null) =>
    guidePathRef.current === path ? guideRef.current : null;

  // Clears a draft something newer replaced; a failure says so rather than leaving it listed.
  const dismissReplacedDraft = async (draftId: string) => {
    try {
      await rawData.handleDismissDraft(draftId);
    } catch (err) {
      toasts.push({
        title: "Couldn't remove the old draft",
        description: describeError(err),
        tone: 'error',
      });
    }
  };
  // A failed draft's Try again: the same sentence as a fresh draft, opened in its place.
  const startRetryDraft = async (draft: DraftRecord) => {
    const path = guidePath;
    const next = await rawData.handleStartDraft(draft.prompt, {
      parent: draft.parent ?? null,
    });
    const latest = guideFor(path);
    if (latest === null) return;
    if (latest.draftId === draft.id) latest.linkDraft(next.id);
    setFirstRunDraftId((id) => (id === draft.id ? next.id : id));
    dispatchNav({ type: 'openDraft', draftId: next.id });
    await dismissReplacedDraft(draft.id);
  };
  // Retries in flight by draft, so the card's and the first-run box's Try again share one.
  const draftRetries = useRef(new Map<string, Promise<void>>());
  const retryDraft = (draft: DraftRecord): Promise<void> => {
    const pending = draftRetries.current.get(draft.id);
    if (pending !== undefined) return pending;
    const attempt = startRetryDraft(draft).finally(() =>
      draftRetries.current.delete(draft.id)
    );
    draftRetries.current.set(draft.id, attempt);
    return attempt;
  };
  // The guide's Send to agent on a task; a refusal stays on the card with the task open.
  const sendGuidedTask = async (taskId: string, choice: SendChoice) => {
    const path = guidePath;
    guide.setSendError(null);
    try {
      if (choice.writes.length > 0) {
        await rawData.handleUpdate(taskId, { writes: choice.writes });
      }
      await rawData.handleDispatch(taskId, undefined, choice.model, {
        effort: choice.effort,
      });
    } catch (err) {
      const latest = guideFor(path);
      if (latest === null) return;
      latest.setSendError(describeError(err));
      openTaskView(taskId, 'spec');
    }
  };
  // The guided draft's Send to agent: the edited draft becomes the task, then it goes out.
  const sendGuidedDraft = async (
    draftId: string,
    input: CreateInput,
    choice: SendChoice
  ) => {
    const path = guidePath;
    const doc = await rawData.handleCreate(input);
    if (doc === null) {
      throw new Error('The project is still starting. Try again in a moment.');
    }
    const latest = guideFor(path);
    // A switch mid-send leaves the new task on its own project's board.
    if (latest === null) return;
    latest.linkTask(doc.meta.id);
    // Sending first moves off the draft's page, so it never flashes as gone.
    await sendGuidedTask(doc.meta.id, { ...choice, writes: [] });
    await dismissReplacedDraft(draftId);
  };
  const showFirstRunBox = () => {
    setFirstRunSetAsideFor(null);
    dispatchNav({ type: 'tv/showOverseer' });
  };
  const restartGuide = () => {
    guide.restart();
    showFirstRunBox();
  };
  useEffect(() => {
    restartGuideRef.current = restartGuide;
    guideRef.current = guide;
    guidePathRef.current = guidePath;
  });
  // The first-run box also shows while the guide waits at Describe it (after a Restart).
  const showFirstRun =
    twoViewsFirstRun ||
    (guide.view?.stage === 'describe' &&
      activeProject !== null &&
      firstRunSetAsideFor !== activeProject.path);
  const guideCard =
    guide.view === null ? null : (
      <FirstTaskGuide
        view={guide.view}
        provider={guideAgent}
        sendOptions={sendOptions}
        sendError={guide.sendError}
        collapsed={guide.collapsed}
        onCollapsedChange={guide.setCollapsed}
        actions={{
          showDescribe: showFirstRunBox,
          openDraft: (draftId) => dispatchNav({ type: 'openDraft', draftId }),
          openTask: (taskId, tab, runId) => openTaskView(taskId, tab, runId),
          send: sendGuidedTask,
          retryDraft,
          // The same agent, model and effort the failed run had.
          retryRun: (taskId) => {
            const failed =
              guide.view?.run?.taskId === taskId ? guide.view.run : undefined;
            return rawData.handleDispatch(
              taskId,
              failed?.executor,
              failed?.model,
              { effort: failed?.effort }
            );
          },
          askAgentToFix: (runId, error) =>
            rawData.handleRequestChanges(runId, askAgentToFix(error)),
          looksGood: guide.approve,
          askForChanges: (runId, text) =>
            rawData.handleRequestChanges(runId, text),
          land: (runId) => rawData.handleReview(runId, 'merge'),
          // The daemon refuses to discard a run with a pull request, so this stays local.
          startOver: (runId) => {
            guide.startOver(runId);
            return Promise.resolve();
          },
          dismiss: guide.dismiss,
          closeCompletion: guide.closeCompletion,
          openBoard: () => {
            guide.closeCompletion();
            dispatchNav({ type: 'tv/showTasks' });
          },
          openOverseer: () => {
            guide.closeCompletion();
            dispatchNav({ type: 'tv/showOverseer' });
          },
          inviteTeammate: () => {
            guide.closeCompletion();
            setGlobalView('settings', { page: 'team' });
          },
        }}
      />
    );

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
      onRestartGuide={activeProject === null ? undefined : restartGuide}
    />
  );

  const peekTaskId =
    twoViewsState.peek?.kind === 'task' ? twoViewsState.peek.taskId : null;

  const closeTwoViewsPage = () => dispatchNav({ type: 'tv/closePage' });

  // A project view shown as a page under Tasks, its own header leading back.
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
    if (hideHostViews && HOST_VIEWS.has(view)) {
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="px-4 pt-2">
            <TasksBackButton onBack={closeTwoViewsPage} />
          </div>
          <EmptyState
            className="flex-1"
            heading="Only the operator can open this"
            description="Terminals act on the host machine as the person running Dispatch."
          />
        </div>
      );
    }
    switch (view) {
      case 'files':
        return <FilesView data={data} onBack={closeTwoViewsPage} />;
      case 'terminals':
        return <TerminalsView data={data} onBack={closeTwoViewsPage} />;
      case 'threads':
        return (
          <ThreadsView
            data={data}
            projectName={activeProject?.name ?? null}
            focus={threadsFocus}
            onFocus={setThreadsFocus}
            onOpenRef={openRef}
            overseer={{
              thread: overseer.record?.thread ?? null,
              busy: overseer.sending || overseer.record?.state === 'running',
              submit: overseer.reply,
              open: openOverseer,
            }}
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
            onCreate={async (input) => {
              const path = guidePath;
              const doc = await rawData.handleCreate(input);
              const latest = guideFor(path);
              if (
                doc !== null &&
                latest !== null &&
                latest.active &&
                latest.draftId === draft.id
              ) {
                latest.linkTask(doc.meta.id);
              }
              return doc;
            }}
            draft={draft}
            onDone={closeTwoViewsPage}
            onRetry={() => retryDraft(draft)}
            send={
              guide.active && guide.draftId === draft.id
                ? {
                    options: sendOptions,
                    onSend: (input, choice) =>
                      sendGuidedDraft(draft.id, input, choice),
                  }
                : undefined
            }
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
      case 'file':
        return (
          <FilesView
            key={page.path}
            data={data}
            initialPath={page.path}
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

  // Sessions and All agents as Settings pages in Two views.
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
    if (me === null) return out;
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
  }, [data.me, mailbox]);
  const forYouRoot = activeProject?.path ?? null;
  const [dismissedPosts, setDismissedPosts] = useState(() =>
    readDismissedPosts(forYouRoot)
  );
  useEffect(() => {
    setDismissedPosts(readDismissedPosts(forYouRoot));
  }, [forYouRoot]);
  const dismissForYou = (dismissed: readonly Post[]) => {
    const next = dismissPosts(dismissedPosts, dismissed, Date.now());
    writeDismissedPosts(forYouRoot, next);
    setDismissedPosts(next);
  };
  const allPosts = useMemo(
    () =>
      data.me === null
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
    [data.me, mailbox, myTaskIds, followedRooms]
  );
  const posts = useMemo(
    () => visiblePosts(allPosts, dismissedPosts),
    [allPosts, dismissedPosts]
  );
  const captures = useMemo(() => openCaptures(data.inbox), [data.inbox]);
  // An agent or narrator door: Tasks on a task, a milestone or a preset.
  const openDoor = (door: OverseerDoor) => {
    const taskId = door.taskId ?? door.milestoneId;
    dispatchNav(
      taskId !== undefined
        ? { type: 'openTask', taskId }
        : { type: 'tv/showTasks', preset: door.preset }
    );
  };
  // The thread open on the Threads page.
  const [threadsFocus, setThreadsFocus] = useState<string | null>(null);
  // What a side column of the Overseer opened in its middle.
  const [overseerFocus, setOverseerFocus] = useState<OverseerFocus | null>(
    null
  );
  // A run address names its task, so a run's post reads as the work it is on.
  const addressName = (address: string) =>
    data.people.find((p) => p.ref === address)?.name ??
    (address.startsWith('run:')
      ? data.runs.find((r) => r.id === address.slice('run:'.length))?.taskTitle
      : undefined) ??
    address.replace(/^(human|a2a|run|agent):/, '');
  // Messages to me not yet read, the quiet count beside "threads".
  const unreadToMe = (mailbox ?? []).filter(
    ({ delivery }) =>
      delivery.recipient === data.me &&
      ['held', 'notified', 'pushed'].includes(delivery.state)
  ).length;
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
  // There is no drafts tray, so a draft started from the composer opens
  // its page straight away; it stays listed under Coming in's Drafts.
  const startDraftAndOpen = async (
    prompt: string,
    options?: { parent?: string | null }
  ) => {
    const record = await rawData.handleStartDraft(prompt, options);
    dispatchNav({ type: 'openDraft', draftId: record.id });
    return record;
  };
  // A notification opened from Coming in: a task or run opens in the middle;
  // anything else goes where the Inbox would send it.
  const openNotification = (entry: InboxEntry) => {
    const { target } = entry;
    const taskId =
      target.kind === 'task'
        ? target.taskId
        : target.kind === 'run'
          ? data.runs.find((run) => run.id === target.runId)?.taskId
          : undefined;
    if (taskId === undefined) {
      navigateFromInbox(target);
      return;
    }
    markNotificationRead(entry.id);
    setOverseerFocus({ kind: 'task', taskId });
  };
  // A reply on a question answers it; on anything else it continues the thread.
  const replyToPost = async (post: Post, body: string) => {
    if (data.client === null) throw new Error('dispatchd client not ready');
    const question = data.me === null ? null : questionToAnswer(post, data.me);
    if (question !== null) {
      await data.client.replyToMessage(question.id, { body });
    } else {
      await data.client.sendMessage(
        { to: [post.subject], kind: 'message', body },
        { continueThread: true }
      );
    }
    void queryClient.invalidateQueries({
      queryKey: threadListsKey(data.port),
    });
  };

  const twoViewsFrame = (
    <>
      <TwoViewShell
        view={twoViewsState.mainView}
        gate={gateScreen ?? agentSetupScreen}
        guide={guideCard}
        banner={
          setupComplete ? (
            <SetupBanner
              report={setupBannerReport}
              onOpen={() =>
                dispatchNav({ type: 'tv/openSettings', page: 'setup' })
              }
            />
          ) : undefined
        }
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
          onOpenDocs: () =>
            dispatchNav({ type: 'setProjectView', view: 'docs' }),
          onOpenThreads: () =>
            dispatchNav({ type: 'setProjectView', view: 'threads' }),
          threadsUnread: unreadToMe,
          page:
            twoViewsState.mainView !== 'tasks'
              ? null
              : tasksPage.kind === 'docs'
                ? 'docs'
                : tasksPage.kind === 'view' && tasksPage.view === 'threads'
                  ? 'threads'
                  : null,
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
            postsCount={posts.length + captures.length}
            runs={data.runs}
            merges={data.mergeQueue?.entries ?? []}
            drafts={
              <DraftsSection
                drafts={data.drafts}
                onOpen={(draftId) =>
                  dispatchNav({ type: 'openDraft', draftId })
                }
                onDismiss={(id) => void data.handleDismissDraft(id)}
              />
            }
            draftsCount={draftTrayViewModel(data.drafts).badgeCount}
            notifications={
              sidePanelNotifications && (
                <NotificationsSection
                  entries={notificationInbox.entries}
                  unreadCount={unreadCount(notificationInbox)}
                  onMarkAllRead={markNotificationInboxRead}
                  onOpen={openNotification}
                  onDismiss={dismissNotification}
                  onClearAll={clearNotifications}
                  onHide={() => setSidePanelNotifications(false)}
                />
              )
            }
            outflow={{
              sessions: data.liveMilestoneSessions,
              milestoneTitle: (id) =>
                data.milestones.find((e) => e.meta.id === id)?.meta.title ?? id,
              mergeReady: mergeReadyCount,
              onMergeAll: data.handleMergeAllReady,
              spendToday: todaySpend,
              ceilings: liveCeilings,
            }}
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
            firstRun={
              showFirstRun ? (
                <FirstRunView
                  projectName={activeProject?.name ?? null}
                  planner={guideAgent === null || guideAgent.plans}
                  // The draft opens under Tasks: Two views has no drafts tray.
                  onStartDraft={async (prompt) => {
                    // A new draft replaces the last one's failure.
                    setFirstRunDraftId(null);
                    const path = guidePath;
                    const draft = await rawData.handleStartDraft(prompt);
                    const latest = guideFor(path);
                    if (latest === null) return draft;
                    setFirstRunDraftId(draft.id);
                    if (latest.active) latest.linkDraft(draft.id);
                    dispatchNav({ type: 'openDraft', draftId: draft.id });
                    return draft;
                  }}
                  onCreateTask={async ({ what, done }) => {
                    const path = guidePath;
                    const doc = await rawData.handleCreate(
                      formTaskInput(
                        what,
                        done,
                        data.config?.statuses[0] ?? 'backlog'
                      )
                    );
                    if (doc === null) {
                      throw new Error(
                        'The project is still starting. Try again in a moment.'
                      );
                    }
                    const latest = guideFor(path);
                    if (latest === null) return;
                    if (latest.active) latest.linkTask(doc.meta.id);
                    openTaskView(doc.meta.id, 'spec');
                  }}
                  failure={
                    failedFirstRun === undefined
                      ? undefined
                      : {
                          error:
                            failedFirstRun.error ?? 'Drafting the task failed.',
                          providerId: providerById(failedFirstRun.plannerName)
                            ?.id,
                          onRetry: () => retryDraft(failedFirstRun),
                        }
                  }
                  onBrowseBoard={() => dispatchNav({ type: 'tv/showTasks' })}
                  onTalkToAgent={() =>
                    setFirstRunSetAsideFor(activeProject?.path ?? null)
                  }
                />
              ) : undefined
            }
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
                  onDismiss={(post) => dismissForYou([post])}
                  onClearAll={dismissForYou}
                  holding={overseerTurnLive(overseer)}
                />
                <CapturedNotes
                  items={captures}
                  onMakeTask={rawData.handleConvertInbox}
                  onDismiss={rawData.handleDismissInbox}
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
            onNewProject={() => openCreateTask({ kind: 'project' })}
            onDispatchTask={cockpitDispatch}
            onDispatchFailed={onCockpitDispatchFailed}
            onPeekTask={peekTask}
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
    </>
  );

  return (
    <TooltipProvider>
      <ShellActionsProvider value={shellActions}>
        <DeepLinkProvider value={deepLinkActions}>
          <SavedViewsProvider value={savedViews}>
            <PageHeaderShellContext.Provider value={TWO_VIEWS_PAGE_HEADER}>
              <PeopleProvider people={data.people} me={data.me}>
                <SurfaceHosts
                  taskPage={taskPageHost}
                  flightPlan={flightPlanHost}
                >
                  <div className="bg-frame relative flex h-screen flex-col overflow-hidden">
                    {twoViewsFrame}

                    <QuickCaptureDialog
                      open={quickCaptureOpen}
                      onOpenChange={setQuickCaptureOpen}
                      onCapture={rawData.handleCaptureInbox}
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
                        milestones={data.milestones}
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
                        onStartDraft={startDraftAndOpen}
                        onQuickAdd={(preset) => {
                          setAiComposerOpen(false);
                          openQuickAddTask(preset);
                        }}
                        onClose={() => setAiComposerOpen(false)}
                      />
                    )}

                    {addProjectOpen && (
                      <AddProjectDialog
                        onAdd={async (path) => {
                          await handleAddProject(path);
                        }}
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
      </ShellActionsProvider>
    </TooltipProvider>
  );
}

export default App;
