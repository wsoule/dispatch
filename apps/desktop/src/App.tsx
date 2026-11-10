import {
  type CreateInput,
  fanoutScope,
  providerById,
  type TaskListItem,
} from '@dispatch-foo/core/browser';
import type { DraftRecord } from '@dispatch/client';
import {
  BlockBar,
  Button,
  EmptyState,
  ShortcutSheet,
  Spinner,
  toggleShellCollapsed,
  useModKeyLabel,
} from '@dispatch/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Coins, TriangleAlert } from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';

import { PALETTE_DOCS_LIMIT } from './adapters/palette';
import {
  buildProjectsSection,
  HOSTED_DESTINATIONS,
  planningProjectMark,
} from './adapters/shell';
import styles from './App.module.css';
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
import { LinearStep } from './components/setup/LinearStep';
import { ReadErrorBanner } from './components/setup/ReadErrorBanner';
import { SetupBanner, setupProblem } from './components/setup/SetupBanner';
import { AddProjectDialog } from './components/shell/AddProjectDialog';
import { CommandPalette } from './components/shell/CommandPalette';
import { ConnectionIndicator } from './components/shell/ConnectionIndicator';
import { DaemonUnavailable } from './components/shell/DaemonUnavailable';
import {
  DeepLinkProvider,
  useCopyTaskLink,
  useWebLinkActions,
} from './components/shell/DeepLinkContext';
import {
  DispatchShell,
  SHELL_STORAGE_KEY,
} from './components/shell/DispatchShell';
import { GateFrame } from './components/shell/GateFrame';
import { PageHead, RUNS_BACK } from './components/shell/PageHead';
import { PresenceStack } from './components/shell/PresenceStack';
import { projectWorkspaceSwitcher } from './components/shell/projectWorkspaces';
import { SavedViewsProvider } from './components/shell/SavedViewsContext';
import {
  type CreateTaskPreset,
  type ShellActions,
  ShellActionsProvider,
} from './components/shell/ShellActionsContext';
import {
  taskToastDescription,
  viewTaskLink,
} from './components/shell/toastContract';
import { useToasts } from './components/shell/Toasts';
import { TaskDrawer } from './components/tasks/detail/TaskDrawer';
import { NeedsYouBlock } from './components/tasks/NeedsYouBlock';
import {
  type TaskPageHost,
  TaskPageHostContext,
} from './components/tasks/page/TaskPageHost';
import { TaskPageView } from './components/tasks/page/TaskPageView';
import {
  type ComposerMode,
  TaskComposerSlideOver,
} from './components/tasks/TaskComposerSlideOver';
import { useAdminItems } from './hooks/useAdminItems';
import { useDataChangedEvents } from './hooks/useDataChangedEvents';
import { useDeepLinkRouter } from './hooks/useDeepLinkRouter';
import { useDispatchProject } from './hooks/useDispatchProject';
import {
  useFirstTaskGuide,
  useFreshEmptyProject,
} from './hooks/useFirstTaskGuide';
import { useGlobalKeyboard } from './hooks/useGlobalKeyboard';
import { useHashRoute } from './hooks/useHashRoute';
import { useOnOpening } from './hooks/useOnOpening';
import { useOverseerSession } from './hooks/useOverseerSession';
import {
  type Planning,
  PlanningContext,
  usePlanning,
} from './hooks/usePlanning';
import { useSavedViews } from './hooks/useSavedViews';
import { useSidePanelNotifications } from './hooks/useSidePanelNotifications';
import { tasksKey } from './hooks/useTaskDoc';
import { setThemeChoice } from './hooks/useThemeChoice';
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
import {
  orbLabel,
  orbState,
  overseerTurnLive,
  revokedLocksComposer,
} from './lib/agentPresence';
import { overseerOf } from './lib/agentRoster';
import {
  escapeLeavesNav,
  type GlobalView,
  HOST_VIEWS,
  type HostedPage,
  initialNavState,
  keyAction,
  type NavAction,
  navReducer,
  type ProjectView,
  type SettingsPage,
  type TaskTab,
} from './lib/appNav';
import { hideArchivedRuns } from './lib/archiveFilter';
import { hasDispatchKey, launchRootKey } from './lib/bootWarm';
import { openCaptures } from './lib/capturedNotes';
import { dispatchConfigKey } from './lib/configEvents';
import { containerStatus } from './lib/containerStatus';
import { mentions, subjectOf } from './lib/conversationScope';
import { type DecisionItem, decisionTarget } from './lib/decisionFeed';
import { resolveIssueTask } from './lib/deepLink';
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
import { buildLandingBoard, landingCounts } from './lib/landingQueue';
import { liveCeilingsOf, spendToday } from './lib/liveSpend';
import { countMergeReady } from './lib/mergeReady';
import { resolveExecuteModel } from './lib/models';
import { awayDigest } from './lib/narrator';
import { needsYou } from './lib/needsYou';
import { isAskNotification } from './lib/notificationEdges';
import type { OverseerDoor } from './lib/overseerThread';
import {
  addressEntries,
  buildPaletteEntries,
  docHitEntries,
} from './lib/paletteEntries';
import { buildPosts, type Post, questionToAnswer } from './lib/posts';
import { basename, parentDir } from './lib/projectName';
import {
  isRemoteRoot,
  listRemoteConnections,
  remoteConnectionFor,
  remoteRootFor,
} from './lib/remoteConnections';
import { prNumberFromUrl } from './lib/reviewTarget';
import { isTerminalRunState } from './lib/runState';
import {
  autoCompleteAction,
  readSetupComplete,
  SETUP_REPORT_STALE_MS,
  setupReportKey,
  writeSetupComplete,
} from './lib/setupState';
import {
  currentShellDestination,
  currentShellPageTitle,
  onUnlistedPage,
} from './lib/shellRoutes';
import { buildShortcutGroups } from './lib/shortcutGroups';
import { useStatusModelOf } from './lib/statusModel';
import { computeBlockedIds } from './lib/taskGraph';
import { itemBucket, queuedTaskIds, taskStatusCounts } from './lib/taskStatus';
import {
  addProject,
  currentProjectRoot,
  ensureDispatchd,
  hasDispatch,
  hostedPlanner,
  isTauri,
  listRegisteredProjects,
  openUrl,
  touchProjectOpened,
} from './lib/tauri';
import {
  isTeamLocalPage,
  readTeamSession,
  signOutOfTeam,
} from './lib/teamLocal';
import { openRefWith, type RefAction } from './lib/threadSources';
import { checkForUpdate, installUpdateAndRelaunch } from './lib/updater';
import { applyZoomFactor, loadZoomFactor, stepZoomFactor } from './lib/zoom';
import { AllAgentsView } from './views/AllAgentsView';
import { DocsView } from './views/DocsView';
import { DraftView } from './views/DraftView';
import { FilesView } from './views/FilesView';
import { FirstRunView } from './views/FirstRunView';
import { GraphView } from './views/GraphView';
import { IssuesView, type TasksSidePage } from './views/IssuesView';
import { LandingView } from './views/LandingView';
import { LiveView } from './views/LiveView';
import { OverseerFocusView } from './views/OverseerFocusView';
import { type OverseerFocus, OverseerView } from './views/OverseerView';
import { ProjectsView } from './views/ProjectsView';
import { PrReviewView } from './views/PrReviewView';
import { SessionsHubView } from './views/SessionsHubView';
import { type HostedSettingsPage, SettingsView } from './views/SettingsView';
import { SetupView } from './views/SetupView';
import { TerminalsView } from './views/TerminalsView';
import { ThreadsView } from './views/ThreadsView';
import { TimelineView } from './views/TimelineView';
import { WeekView } from './views/WeekView';

// The hosts a task page and a Flight Plan draw from, provided together so the shell's
// provider stack stays one level deep.
function SurfaceHosts({
  taskPage,
  flightPlan,
  planning,
  children,
}: {
  taskPage: TaskPageHost | null;
  flightPlan: FlightPlanHost;
  /** The planning over the open project, computed once for the timeline,
   * the sidebar's project marks and the drawer's Milestone section. */
  planning: Planning;
  children: ReactNode;
}) {
  return (
    <TaskPageHostContext.Provider value={taskPage}>
      <FlightPlanHostContext.Provider value={flightPlan}>
        <PlanningContext.Provider value={planning}>
          {children}
        </PlanningContext.Provider>
      </FlightPlanHostContext.Provider>
    </TaskPageHostContext.Provider>
  );
}

function App() {
  const queryClient = useQueryClient();
  const [navState, dispatchNav] = useReducer(navReducer, initialNavState);
  // What a side column of the Overseer opened in its middle (declared here,
  // before the global keyboard's Escape reads it).
  const [overseerFocus, setOverseerFocus] = useState<OverseerFocus | null>(
    null
  );
  const [showCreate, setShowCreate] = useState(false);
  // What a board column's or list group's "+" pre-fills into the creator (its status, kind
  // and parent container); `null` leaves every field to its default.
  const [createPreset, setCreatePreset] = useState<CreateTaskPreset | null>(
    null
  );
  // Whether the shell's brand row clears the macOS traffic lights.
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
  // opened — and is deliberately OFF the boot path: the app resolves its
  // launch project and renders immediately; listing *other* projects must never
  // be able to hang the app (the failure mode the single-project pivot fixed).
  //
  // The list is the registry (`~/.dispatch/projects.json`) alone: projects the
  // user added or switched to, minus any whose folder is gone, newest first. It
  // used to also merge every Claude Code session folder the watcher had seen
  // with a `.dispatch/` dir, and since `.dispatch/config.yml` is checked in,
  // every git worktree of a dispatch repo qualified — dozens of short-lived
  // agent worktrees flooded the menu.
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const { data: registeredProjects } = useQuery({
    queryKey: ['switcher-projects'],
    // Paired remote daemons follow the registry, marked as remote.
    queryFn: async () => {
      const registered = await listRegisteredProjects();
      const merged = registered.map((r) => ({ path: r.path, name: r.name }));
      for (const remote of listRemoteConnections()) {
        merged.push({
          path: remoteRootFor(remote.id),
          name: `${remote.name} · ${new URL(remote.baseUrl).host}`,
        });
      }
      return merged;
    },
    enabled: switcherOpen,
    staleTime: 30_000,
    retry: false,
  });
  // A window launched with `--root` (or from a dev checkout) may be on a
  // project the registry has never seen. It is kept reachable for this session
  // without being registered, so switching away still offers a way back.
  const switchProjects = useMemo(() => {
    const projects = (registeredProjects ?? []).map((p) => ({
      path: p.path,
      name: p.name,
    }));
    if (launchRoot != null && !projects.some((p) => p.path === launchRoot)) {
      projects.push({
        path: launchRoot,
        name: basename(launchRoot),
      });
    }
    return projects;
  }, [registeredProjects, launchRoot]);

  const [addProjectOpen, setAddProjectOpen] = useState(false);

  const selectSwitchProject = useCallback((path: string) => {
    setOverrideRoot(path);
    // Stamp `lastOpenedAt` so this project becomes the registry's "most recent", which
    // `current_project_root`'s reopen-last chain follows on next launch (the switcher
    // itself lists projects by name).
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
        ? {
            path: root,
            name: remoteConnectionFor(root)?.name ?? basename(root),
          }
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

  // `page` lands Settings on one of its pages; `g s` and the sidebar's Settings link
  // leave it to the last page.
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
  // Describing the task in natural language is the primary path; the composer's Quick add
  // mode is the structured fallback.
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
    setShowCreate(false);
    dispatchNav({ type: 'closeNewTask' });
  }, []);

  // The structured quick-add fallback: the composer's Quick add mode, for when you already know
  // the exact fields and don't want to spend an agent round-trip describing them. Reachable
  // from the palette; the composer's own Mode control switches to the same mode.
  const openQuickAddTask = useCallback((preset?: CreateTaskPreset) => {
    setCreatePreset(preset ?? null);
    setShowCreate(true);
  }, []);

  // The Tasks side page right now; read by callbacks made before it is computed below.
  const taskPageRef = useRef<{ on: boolean; taskId: string | null }>({
    on: false,
    taskId: null,
  });
  // Moves nav state to the newly (re-)dispatched run. The task view is the only run surface
  // now, and a run that has just been created is live, so it opens on Run.
  const onRunDispatched = useCallback((runId: string, taskId: string) => {
    // A run started from the task page already open stays on that page.
    const page = taskPageRef.current;
    if (page.on && page.taskId === taskId) {
      dispatchNav({ type: 'setTaskTab', tab: 'run' });
      dispatchNav({ type: 'openRun', runId });
      return;
    }
    dispatchNav({ type: 'openTask', taskId, tab: 'run', runId });
  }, []);

  // The run the task page is pinned to: the only surface that shows one.
  const selectedRunId =
    navState.tasksPage.kind === 'task' ? navState.tasksPage.runId : null;
  const rawData = useDispatchProject(activeProject?.path ?? null, {
    selectedRunId,
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
  // the full page or the quick-look drawer, whichever is showing. Best effort:
  // a failed report costs a teammate one stale "viewing", never an error here.
  const shownTaskId =
    navState.tasksPage.kind === 'task'
      ? navState.tasksPage.taskId
      : navState.peek?.kind === 'task'
        ? navState.peek.taskId
        : null;
  const openTaskPageId =
    navState.mainView === 'tasks' && navState.tasksPage.kind === 'task'
      ? navState.tasksPage.taskId
      : null;
  useEffect(() => {
    taskPageRef.current = {
      on: openTaskPageId !== null,
      taskId: openTaskPageId,
    };
  }, [openTaskPageId]);
  const focusedTaskId = shownTaskId;
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

  // A route's actions, as the shell's links, the graph's links and the hash
  // deliver them. An `openTask` naming no run gets the task's latest, as
  // `openTaskView` does for every other way in, so Run and Review have
  // something to show and the hash then names the run.
  const navigate = useCallback(
    (action: NavAction) => {
      if (action.type === 'openTask' && (action.runId ?? null) === null) {
        openTaskView(action.taskId, action.tab);
        return;
      }
      dispatchNav(action);
    },
    [openTaskView]
  );
  // `location.hash` mirrors the place, and a hash the window opens on (or a
  // link the browser followed itself) is applied as a route.
  useHashRoute({ state: navState, dispatch: navigate });

  // A Tasks-page row or card click: a phase drill from the milestones layout names
  // its tab and opens the full page; a plain click is the quick-look drawer
  // (owner decision: click and Space peek, Enter and o open). Stable, so memo'd
  // rows can skip renders.
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
        openFile: (path) => dispatchNav({ type: 'openFile', path }),
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
  const webLinkActions = useWebLinkActions(hostedPlanner() !== null);
  const deepLinkActions = useMemo(
    () => ({ copyTaskLink, ...webLinkActions }),
    [copyTaskLink, webLinkActions]
  );
  useDeepLinkRouter({
    activeProjectPath: activeProject?.path ?? null,
    tasksReady: data.tasksReady,
    hasTask: (id) => data.tasksIncludingArchived.some((t) => t.meta.id === id),
    hasDispatch,
    switchProject: selectSwitchProject,
    openTask: (id) => openTaskView(id),
    // Fresh links, so an issue linked since the last refetch still resolves;
    // the cached map stands in when the daemon cannot answer.
    findIssueTask: async (identifier) => {
      const links =
        data.client === null
          ? data.linearLinks
          : await data.client.fetchLinearLinks().catch(() => data.linearLinks);
      return resolveIssueTask(identifier, links, data.tasksIncludingArchived);
    },
    openRun: async (runId) => {
      const run =
        rawData.runs.find((r) => r.id === runId) ??
        (data.client === null
          ? undefined
          : await data.client
              .fetchRun(runId)
              .then((detail) => detail.meta)
              .catch(() => undefined));
      if (run === undefined) return false;
      openTaskView(
        run.taskId,
        isTerminalRunState(run.state) ? 'review' : 'run',
        run.id
      );
      return true;
    },
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
        // A dismissed item that later cleared was waved off, not decided.
        item.dismissedAt === undefined &&
        Date.parse(item.resolvedAt) >= since &&
        (item.owner === undefined || item.owner === data.me)
    );
  }, [data.decisions, data.me]);
  const blockedIds = useMemo(
    () => computeBlockedIds(data.tasks, statusModel),
    [data.tasks, statusModel]
  );
  // The sidebar's Landing counts, from the same read model the Landing page renders.
  const landing = useMemo(
    () =>
      landingCounts(
        buildLandingBoard(
          data.mergeQueue,
          data.tasksIncludingArchived,
          statusModel,
          Date.now()
        )
      ),
    [data.mergeQueue, data.tasksIncludingArchived, statusModel]
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
  // The planning chain over the open project (milestone assessments, the
  // timeline, the connectors), once for every surface that reads it.
  const planning = usePlanning(data);
  const { snapshot: planningSnapshot, assessments: planningAssessments } =
    planning;
  // The project whose lane the Timeline is focused on, marked current in the
  // sidebar's Projects section while that page shows.
  const focusedProjectId =
    navState.tasksPage.kind === 'view' && navState.tasksPage.view === 'timeline'
      ? navState.tasksPage.project
      : null;
  // The sidebar's Projects section: every project marked by the planning's
  // reading of its next milestone, else the rolled-up status of the issues
  // under it, in the top bar's old units (asks, failures).
  const projectsSection = useMemo(() => {
    const childrenOf = new Map<string, TaskListItem[]>();
    for (const doc of data.tasks) {
      if (doc.meta.parent === null) continue;
      const siblings = childrenOf.get(doc.meta.parent);
      if (siblings === undefined) childrenOf.set(doc.meta.parent, [doc]);
      else siblings.push(doc);
    }
    return buildProjectsSection({
      tasks: data.tasks,
      containerStatusOf: (id) =>
        containerStatus(
          fanoutScope(id, (parent) => childrenOf.get(parent) ?? []),
          { bucketOf, asksByTask: needs.byTask, model: statusModel }
        ),
      statusOf: (projectId) =>
        planningProjectMark(planningSnapshot, planningAssessments, projectId),
      currentId: focusedProjectId,
    });
  }, [
    data.tasks,
    bucketOf,
    needs.byTask,
    statusModel,
    planningSnapshot,
    planningAssessments,
    focusedProjectId,
  ]);
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
  // Capture is preset-free like every other entry: the composer's Mode control can move on to
  // Quick add or Describe, which must not inherit the last "+"'s status, kind and parent.
  const openQuickCapture = useCallback(() => {
    if (!quickCaptureAvailable) return;
    setCreatePreset(null);
    setQuickCaptureOpen(true);
  }, [quickCaptureAvailable]);

  // The one task composer stays mounted while any of its three entry states is open, and
  // shows the mode that state asks for: the structured form (`openQuickAddTask`, or a
  // non-task preset), the quick capture (⌘D, "Drop a thought"), or Describe (`c`, "New
  // task"). `null` means the composer is closed.
  const composerMode: ComposerMode | null = showCreate
    ? 'quick'
    : quickCaptureOpen
      ? 'capture'
      : navState.composerOpen
        ? 'describe'
        : null;
  // The composer's Mode control: moves to one entry state and clears the other two, so
  // exactly one is open. Quick add keeps `createPreset`; capture opens only when a capture
  // can land (see `quickCaptureAvailable`).
  const changeComposerMode = useCallback(
    (mode: ComposerMode) => {
      switch (mode) {
        case 'describe':
          setShowCreate(false);
          setQuickCaptureOpen(false);
          dispatchNav({ type: 'openNewTask' });
          break;
        case 'quick':
          dispatchNav({ type: 'closeNewTask' });
          setQuickCaptureOpen(false);
          setShowCreate(true);
          break;
        case 'capture':
          if (!quickCaptureAvailable) return;
          dispatchNav({ type: 'closeNewTask' });
          setShowCreate(false);
          setQuickCaptureOpen(true);
          break;
      }
    },
    [quickCaptureAvailable]
  );
  // Closing the composer (Escape, the scrim, a submit) clears every entry state and the
  // preset, so nothing carries over into the next open.
  const closeComposer = useCallback(() => {
    dispatchNav({ type: 'closeNewTask' });
    setShowCreate(false);
    setQuickCaptureOpen(false);
    setCreatePreset(null);
  }, []);
  // Settings (⌘, works while typing, or the palette and the sidebar) is a page in the shell's
  // main column, under the browser's top layer, so the composer's modal SlideOver (z-index 50)
  // would cover it: opening Settings closes the composer, in the same render, so the composer
  // hands focus back to its opener before Settings shows (see useOnOpening).
  useOnOpening(navState.settings !== null, closeComposer);

  const openShortcuts = useCallback(
    () => dispatchNav({ type: 'openShortcuts' }),
    []
  );
  // The "?" sheet's rows, with the platform's modifier label in every
  // modified shortcut (⌘ on a Mac, Ctrl elsewhere).
  const modLabel = useModKeyLabel();
  const shortcutGroups = useMemo(
    () => buildShortcutGroups(modLabel),
    [modLabel]
  );

  // Quick open over the project Files page and over a task page's run Files
  // tab lives in the nav state, so ⌘P (the `quick-open` command, through
  // `keyAction`) opens it from any destination and Escape peels it like the
  // other overlays. Only the run Files embedded in the Overseer's column keeps
  // its own local quick-open state.
  const onQuickOpenChange = useCallback((open: boolean) => {
    dispatchNav({ type: open ? 'openQuickOpen' : 'closeQuickOpen' });
  }, []);

  useGlobalKeyboard({
    // `modalOpen` is computed inside the hook itself, via a live DOM check for
    // any open `aria-modal` dialog. SessionDetailModal (@dispatch/ui's modal
    // SlideOver) and DiffModal (its Dialog) set aria-modal through the
    // library, so while either is open inside Settings › Usage the global
    // commands stay suppressed, the same as TaskComposerSlideOver does.
    onCommand: (command) => {
      // The `goto-*` keys and `quick-open` (⌘P) resolve through `keyAction`.
      const action = keyAction(command);
      if (action !== null) {
        if (action !== 'swallow') dispatchNav(action);
        return;
      }
      if (command === 'open-palette') dispatchNav({ type: 'togglePalette' });
      else if (command === 'escape') {
        // This window listener runs before the Overseer's own Escape and
        // claims the key, so it hands a focus back to the talk itself once
        // nothing of the app's (a peek, Settings, the palette) sits above it.
        if (
          navState.mainView === 'overseer' &&
          overseerFocus !== null &&
          escapeLeavesNav(navState)
        ) {
          setOverseerFocus(null);
        } else dispatchNav({ type: 'escape' });
      } else if (command === 'nav-back') dispatchNav({ type: 'back' });
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
      // `[` and ⌘B: the shell leaves the key to the app (`sidebarShortcut` off).
      else if (command === 'toggle-sidebar') {
        toggleShellCollapsed(SHELL_STORAGE_KEY);
      } else if (command === 'new-task') {
        if (activeProject !== null) openCreateTask();
      } else if (command === 'open-shortcuts') openShortcuts();
    },
  });

  // What every task surface — the quick-look drawer and the full page — draws a
  // task with: the project and where its links go. Absent until the config has loaded.
  const rawHandleDispatch = rawData.handleDispatch;
  const rawHandleUpdate = rawData.handleUpdate;
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
          // Raw too: the drawer's edit controls print a refusal beside themselves.
          updateTask: rawHandleUpdate,
          moveTaskStatus: rawMoveTaskStatus,
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
          // The Tasks page's run Files tab is a Files page to the nav state, so
          // ⌘P opens quick open over the run's worktree in place; embedded in
          // the Overseer's column, the tab keeps quick open to itself.
          filesView: (runId: string, embedded: boolean) =>
            embedded ? (
              <FilesView data={data} runId={runId} />
            ) : (
              <FilesView
                data={data}
                runId={runId}
                quickOpen={navState.quickOpen}
                onQuickOpenChange={onQuickOpenChange}
              />
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
        dispatchNav({ type: 'showOverseer' });
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
      bucketOf,
      asksByTask: needs.byTask,
      projectKey: activeProject?.path ?? '',
      dispatchTask: cockpitDispatch,
      onDispatchFailed: onCockpitDispatchFailed,
      onOpenTask: openTaskView,
      onPeekTask: peekTask,
      sendAgents,
      onSendAgentsServed,
    }),
    [
      data,
      bucketOf,
      needs.byTask,
      activeProject?.path,
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
              .searchDocs(query, { limit: PALETTE_DOCS_LIMIT })
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
        currentTaskId: shownTaskId,
        hideHostViews,
        actions: {
          openCreateTask: () => openCreateTask(),
          openQuickAddTask: () => openQuickAddTask(),
          setProjectView: selectProjectView,
          setGlobalView,
          // The quick-look drawer opens over whichever view is showing (the
          // old peek switched to the list first, where it was a pane).
          peekTask,
          dispatchTask: (taskId) => void handleDispatch(taskId),
          openQuickCapture,
          openShortcuts,
          openSavedView,
          copyTaskLink,
          restartGuide: () => restartGuideRef.current(),
          // The palette shows this row only while a choice is stored.
          followSystemTheme: () => setThemeChoice('system'),
        },
      }),
      ...addressEntries({
        people: data.people,
        rooms: paletteRooms.map((room) => room.name),
        peers: palettePeers,
        me: data.me,
        open: (address) => dispatchNav({ type: 'openAddress', address }),
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
      shownTaskId,
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
  const emptyProjectFirstRun =
    activeProject !== null &&
    firstRunSetAsideFor !== activeProject.path &&
    data.tasksReady &&
    data.tasksIncludingArchived.length === 0;

  // Resolution, first-project and get-started screens take precedence over any view.
  const gateScreen: ReactNode =
    resolutionError !== null ? (
      <div className={styles.centred} role="alert">
        <EmptyState
          icon={
            <TriangleAlert
              className={styles.alertIcon}
              data-tone="danger"
              aria-hidden="true"
              size={20}
              strokeWidth={1.8}
            />
          }
        >
          {resolutionError}
        </EmptyState>
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
      // The region announces the sentence; the Spinner (label="") stays hidden from assistive
      // tech so it is read once.
      <div className={styles.centred} role="status">
        <EmptyState icon={<Spinner size="lg" label="" />}>
          Loading project…
        </EmptyState>
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
        linearStep={
          <LinearStep
            connected={data.linearStatus?.connected ?? null}
            onConnect={() => {
              writeSetupComplete();
              setSetupComplete(true);
              dispatchNav({ type: 'openSettings', page: 'integrations' });
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
    dispatchNav({ type: 'showOverseer' });
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
    emptyProjectFirstRun ||
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
            dispatchNav({ type: 'showTasks' });
          },
          openOverseer: () => {
            guide.closeCompletion();
            dispatchNav({ type: 'showOverseer' });
          },
          inviteTeammate: () => {
            guide.closeCompletion();
            setGlobalView('settings', { page: 'team' });
          },
        }}
      />
    );

  // The brand row's project switcher. Opening it is what loads the other
  // projects (the lazy 'switcher-projects' query above follows switcherOpen).
  const workspaceSwitcher = projectWorkspaceSwitcher({
    active:
      activeProject === null
        ? null
        : { name: activeProject.name, path: activeProject.path },
    projects: switchProjects ?? [],
    onSelectProject: selectSwitchProject,
    onAddProject: () => setAddProjectOpen(true),
    onOpenChange: setSwitcherOpen,
  });

  const peekTaskId =
    navState.peek?.kind === 'task' ? navState.peek.taskId : null;

  const closeSidePage = () => dispatchNav({ type: 'closePage' });

  // A project view shown as a page under Tasks, its own header leading back.
  const renderHostedView = (page: HostedPage): ReactNode => {
    const { view } = page;
    if (data.portLoading || data.portError || data.client === null) {
      return (
        <div className={styles.hostedPage}>
          <div className={styles.hostedHead}>
            {/* Live closes back to Runs, so its chip says so. */}
            <PageHead
              back={
                view === 'live'
                  ? { ...RUNS_BACK, onBack: closeSidePage }
                  : { onBack: closeSidePage }
              }
            />
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
        <div className={styles.hostedPage}>
          <div className={styles.hostedHead}>
            <PageHead onBack={closeSidePage} />
          </div>
          <div className={styles.centred}>
            <EmptyState label="Only the operator can open this">
              Terminals act on the host machine as the person running Dispatch.
            </EmptyState>
          </div>
        </div>
      );
    }
    switch (page.view) {
      case 'files':
        return (
          <FilesView
            data={data}
            quickOpen={navState.quickOpen}
            onQuickOpenChange={onQuickOpenChange}
          />
        );
      case 'terminals':
        return <TerminalsView data={data} />;
      case 'threads':
        return (
          <ThreadsView
            data={data}
            focus={threadsFocus}
            onFocus={setThreadsFocus}
            onOpenRef={openRef}
            overseer={{
              thread: overseer.record?.thread ?? null,
              busy: overseer.sending || overseer.record?.state === 'running',
              submit: overseer.reply,
              open: openOverseer,
            }}
          />
        );
      case 'timeline':
        return (
          <TimelineView
            // A request-tier token cannot write: no re-date handles.
            readOnly={data.myTier === 'request'}
            selectedId={peekTaskId}
            focusProjectId={page.project}
            // Raw, so a refusal reaches the chart, which announces it and
            // rolls the bar back (the toasting wrapper never rejects).
            onRedate={(milestoneId, dueDate) =>
              rawHandleUpdate(milestoneId, { dueDate })
            }
          />
        );
      case 'graph':
        // The dependency chart; a route that names a scope narrows it, and
        // opening a task quick-looks it in the drawer.
        return (
          <GraphView
            data={data}
            bucketOf={bucketOf}
            asksByTask={needs.byTask}
            projectKey={activeProject?.path ?? ''}
            scope={page.scope}
            nodeId={page.nodeId}
            onNavigate={navigate}
          />
        );
      case 'runs':
        // Every run, archived ones included: the sidebar's Runs row.
        return (
          <AllAgentsView
            title="Runs"
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
            // The Live page (Runs › Live); leaving it returns here.
            onOpenLive={() =>
              dispatchNav({ type: 'setProjectView', view: 'live' })
            }
          />
        );
      case 'week':
        // One person's open issues by milestone, deadlines and attention.
        return <WeekView me={data.me} client={data.client} port={data.port} />;
      case 'projects':
        // The projects register: every open project with its status, next
        // milestone and lead, grouped by initiative. Its rows and cells are
        // real hrefs the shell's link provider resolves.
        return <ProjectsView data={data} />;
      case 'live':
        // Every container with work moving: dispatches in place, a node's
        // page on `o`, its quick look on Enter and Space. It reads as
        // Runs › Live, so its back chip (`closePage`) returns to the Runs
        // page, as Escape does (lib/appNav.ts `leavePage`).
        return (
          <LiveView
            data={data}
            bucketOf={bucketOf}
            asksByTask={needs.byTask}
            projectKey={activeProject?.path ?? ''}
            dispatchTask={cockpitDispatch}
            onDispatchFailed={onCockpitDispatchFailed}
            onOpenTask={openTaskView}
            onPeekTask={peekTask}
            onBack={closeSidePage}
          />
        );
      case 'landing':
        return (
          <LandingView
            data={data}
            onOpenRun={(taskId, runId) =>
              dispatchNav({ type: 'openTask', taskId, runId })
            }
          />
        );
    }
  };

  // What Tasks shows instead of its list. A task here is always the full page;
  // the quick look is the drawer in the peek slot below.
  const renderSidePage = (page: TasksSidePage): ReactNode => {
    switch (page.kind) {
      case 'task':
        return data.config === null ? null : (
          <TaskPageView
            key={page.taskId}
            taskId={page.taskId}
            mode={page.tab}
            onModeChange={(tab) => dispatchNav({ type: 'setTaskTab', tab })}
            runId={page.runId}
            onSelectRun={(runId) => dispatchNav({ type: 'openRun', runId })}
            onBack={closeSidePage}
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
                header={<BlockBar title="Discussion" />}
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
            onBack={closeSidePage}
            tasksPage
          />
        );
      case 'draft': {
        const draft = data.drafts.find((d) => d.id === page.draftId);
        return draft === undefined || data.config === null ? (
          <div className={styles.centred}>
            <EmptyState>That draft is no longer available.</EmptyState>
          </div>
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
            onDone={closeSidePage}
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
            onBack={closeSidePage}
          />
        );
      case 'view':
        return renderHostedView(page);
      case 'file':
        return (
          <FilesView
            key={page.path}
            data={data}
            initialPath={page.path}
            quickOpen={navState.quickOpen}
            onQuickOpenChange={onQuickOpenChange}
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

  const tasksPage = navState.tasksPage;
  // Which sidebar row is current, read off the same state the views render from.
  const shellDestination = currentShellDestination(navState);
  // The hosted planner (app.dispatch.foo) has no machine behind it: a place
  // that needs one (the Overseer, the app's own landing page) opens the
  // Timeline instead.
  const hosted = hostedPlanner() !== null;
  const hostedElsewhere =
    hosted &&
    shellDestination !== 'settings' &&
    !HOSTED_DESTINATIONS.has(shellDestination);
  useEffect(() => {
    if (hostedElsewhere) dispatchNav({ type: 'openTimeline', project: null });
  }, [hostedElsewhere, dispatchNav]);
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

  // Usage as a hosted Settings page (SessionsHubView); Runs is its own page.
  const hostedSettingsPages: HostedSettingsPage[] = [
    {
      id: 'usage',
      label: 'Usage',
      icon: Coins,
      intro: 'Every agent session and what it cost.',
      // The hosted view draws no page header of its own: Settings' title sits
      // above it, and the view starts at its own toolbar row.
      render: () => <SessionsHubView />,
    },
  ];

  // A link inside a peek closes it, so the peek never sits over where it led.
  const openRefFromPeek = (action: RefAction) => {
    dispatchNav({ type: 'closePeek' });
    openRef(action);
  };
  const closePeek = () => dispatchNav({ type: 'closePeek' });
  const peek = navState.peek;
  const peekView: ReactNode =
    peek?.kind === 'task' ? (
      // The quick-look slide-over, remounted per task so per-task state (an
      // open comment box, an in-flight dispatch) never leaks across a drawer
      // re-pointed at another task.
      <TaskDrawer key={peek.taskId} taskId={peek.taskId} onClose={closePeek} />
    ) : peek?.kind === 'thread' ? (
      <ThreadPeek
        key={peek.messageId}
        data={data}
        overseer={overseer}
        messageId={peek.messageId}
        onOpenRef={openRefFromPeek}
        onOpenHome={(address) => dispatchNav({ type: 'openAddress', address })}
        onShowOverseer={() => dispatchNav({ type: 'showOverseer' })}
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
          dispatchNav({ type: 'openSettings', page: 'a2a' })
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
        : { type: 'showTasks', preset: door.preset }
    );
  };
  // The thread open on the Threads page.
  const [threadsFocus, setThreadsFocus] = useState<string | null>(null);
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

  // A setup gate (first launch, a folder without .dispatch/, the agent check)
  // takes the whole window in the signed-out frame instead of the app shell,
  // so the screen has one <main>. The resolution error and "Loading project…"
  // stay in the shell's gate slot.
  const setupGate =
    resolutionError === null &&
    (noProjectYet || showGetStarted || agentSetupScreen !== null);
  const settingsOpen = navState.settings !== null;

  const shell = (
    <DispatchShell
      projectName={activeProject?.name ?? null}
      view={navState.mainView}
      destination={shellDestination}
      taskTitle={currentShellPageTitle(navState, aboutTask?.title ?? null)}
      standalonePage={onUnlistedPage(navState)}
      overseerBadge={{ count: orb.count, tone: orb.tone, label: orbTitle }}
      needsYou={needs.count}
      threadsUnread={unreadToMe}
      landing={landing}
      adminItems={admin}
      projects={projectsSection}
      tier={data.myTier}
      teamSession={teamSession}
      hosted={hosted}
      windowChrome={{ dragRegion: isTauri(), trafficLightInset }}
      onNavigate={navigate}
      onSearch={() => dispatchNav({ type: 'openPalette' })}
      workspaceSwitcher={workspaceSwitcher}
      topbarActions={
        activeProject !== null && (
          <>
            <ConnectionIndicator
              status={data.eventStream}
              remoteOrigin={data.remoteOrigin}
            />
            <PresenceStack
              presence={data.presence}
              onOpenPerson={(ref) =>
                dispatchNav({ type: 'openAddress', address: ref })
              }
              taskTitle={(id) =>
                data.tasksIncludingArchived.find((t) => t.meta.id === id)?.meta
                  .title
              }
            />
          </>
        )
      }
      // Over a setup gate the shell shows only Settings: a gate it never
      // draws keeps Overseer and Tasks from mounting under it.
      gate={setupGate ? false : (gateScreen ?? agentSetupScreen)}
      guide={guideCard}
      // Only while a step wants a person: the shell's banner slot is a styled
      // strip, and an empty SetupBanner inside it would still draw a band.
      banner={
        data.readError !== null ? (
          <ReadErrorBanner
            error={data.readError}
            onRetry={() => void queryClient.invalidateQueries()}
          />
        ) : setupComplete && setupProblem(setupBannerReport) !== undefined ? (
          <SetupBanner
            report={setupBannerReport}
            onOpen={() => dispatchNav({ type: 'openSettings', page: 'setup' })}
          />
        ) : undefined
      }
      overseer={
        <OverseerView
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
              onOpen={(draftId) => dispatchNav({ type: 'openDraft', draftId })}
              onDismiss={(id) => void data.handleDismissDraft(id)}
            />
          }
          draftsCount={draftTrayViewModel(data.drafts).badgeCount}
          notifications={
            sidePanelNotifications && (
              <NotificationsSection
                entries={notificationInbox.entries.filter(
                  (entry) => !isAskNotification(entry)
                )}
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
          onShowAsks={() => dispatchNav({ type: 'showTasks' })}
          onOpenDoor={openDoor}
          onOpenExternal={(url) => {
            if (isTauri()) void openUrl(url);
            else window.open(url, '_blank', 'noopener');
          }}
          firstRun={
            showFirstRun ? (
              <FirstRunView
                projectName={activeProject?.name ?? null}
                planner={guideAgent === null || guideAgent.plans}
                // The draft opens under Tasks: Overseer has no drafts tray.
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
                onBrowseBoard={() => dispatchNav({ type: 'showTasks' })}
                onTalkToAgent={() =>
                  setFirstRunSetAsideFor(activeProject?.path ?? null)
                }
              />
            ) : undefined
          }
          onOpenConnectedAgents={() =>
            dispatchNav({
              type: 'openSettings',
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
        <IssuesView
          data={data}
          needs={needs}
          decided={recentlyDecided}
          counts={statusCounts}
          page={tasksPage}
          mode={navState.tasksMode}
          onModeChange={(mode) => dispatchNav({ type: 'setTasksMode', mode })}
          preset={navState.tasksPreset}
          onPreset={(preset) => dispatchNav({ type: 'setTasksPreset', preset })}
          project={navState.tasksProject}
          onClearProject={() =>
            dispatchNav({ type: 'setTasksProject', project: null })
          }
          presetContext={presetContext}
          onSelectTask={selectBoardTask}
          onOpenTask={(taskId) => openTaskView(taskId)}
          peekTaskId={peekTaskId}
          onNewTask={() => openCreateTask()}
          onOpenRef={openRef}
          onOpenDecision={onOpenDecision}
          onClosePage={closeSidePage}
          speechByTask={speechByTask}
          onOpenPr={(number) => dispatchNav({ type: 'openPr', number })}
          onOpenDoc={(docId) => openDoc(docId, null)}
          onOpenAllDocs={() =>
            dispatchNav({ type: 'setProjectView', view: 'docs' })
          }
          renderPage={renderSidePage}
          composer={
            // Threads carries its own reply box: one composer per screen.
            hosted ||
            (tasksPage.kind === 'view' &&
              tasksPage.view === 'threads') ? undefined : (
              <TasksComposer
                overseer={overseer}
                about={aboutTask}
                onOpenOverseer={() => dispatchNav({ type: 'showOverseer' })}
                disabled={revokedLocksComposer(overseer)}
                project={activeProject?.path ?? ''}
              />
            )
          }
        />
      }
      settings={
        navState.settings === null ? null : (
          <SettingsView
            activeProject={activeProject}
            data={settingsData}
            initialPage={navState.settings}
            onSelectPage={(page) => dispatchNav({ type: 'openSettings', page })}
            onOpenTask={(taskId) => openTaskView(taskId, 'auto')}
            hostedPages={hostedSettingsPages}
            planner={hosted}
            pageExtras={{
              autonomy:
                data.client === null ? null : (
                  <OverseerGrantsGroup
                    client={data.client}
                    port={data.port}
                    conversationId={overseer.conversationId}
                  />
                ),
              agents:
                data.client === null || hosted ? null : (
                  <MemoryRecent client={data.client} port={data.port} />
                ),
            }}
          />
        )
      }
      settingsPage={navState.settings}
      peek={peekView}
    />
  );

  // Two fixed slots, so neither remounts when the other comes or goes. Settings
  // opened over a setup gate (the palette, G S, the gate's own Settings button)
  // is an overlay place there too: the shell mounts in the second slot for
  // Settings alone while the gate stays mounted, hidden, in the first (typed
  // values, the chosen agent and a running install or sign-in kept), and
  // closing Settings shows the gate again with focus back where it was.
  const appFrame = (
    <>
      {setupGate && (
        <GateFrame
          hidden={settingsOpen}
          windowChrome={{ dragRegion: isTauri(), trafficLightInset }}
          errorLabel="the setup"
          actions={
            // The agent check runs in a project, whose Settings can be opened
            // over the gate; first launch has no project yet.
            activeProject !== null && (
              <Button
                variant="quiet"
                size="sm"
                onClick={() => dispatchNav({ type: 'openSettings' })}
              >
                Settings
              </Button>
            )
          }
        >
          {gateScreen ?? agentSetupScreen}
        </GateFrame>
      )}
      {(!setupGate || settingsOpen) && shell}
    </>
  );

  return (
    <ShellActionsProvider value={shellActions}>
      <DeepLinkProvider value={deepLinkActions}>
        <SavedViewsProvider value={savedViews}>
          <PeopleProvider people={data.people} me={data.me}>
            <SurfaceHosts
              taskPage={taskPageHost}
              flightPlan={flightPlanHost}
              planning={planning}
            >
              <div className={styles.frame}>
                {appFrame}

                <TaskComposerSlideOver
                  open={composerMode !== null}
                  mode={composerMode ?? 'describe'}
                  onModeChange={changeComposerMode}
                  projectName={activeProject?.name}
                  statuses={data.config?.statuses ?? []}
                  milestones={data.milestones}
                  initialStatus={createPreset?.status}
                  labels={labelCatalogue}
                  labelDefinitions={data.config?.labels}
                  onCreate={(input) => data.handleCreate(input)}
                  onDraft={startDraftAndOpen}
                  onCapture={
                    quickCaptureAvailable
                      ? rawData.handleCaptureInbox
                      : undefined
                  }
                  onUploadAttachments={data.handleUploadAttachments}
                  daemon={
                    daemonDown
                      ? {
                          starting: data.portLoading,
                          errorDetail: data.portErrorDetail,
                          onRetry: data.retryEnsureDispatchd,
                        }
                      : null
                  }
                  onClose={closeComposer}
                />

                {addProjectOpen && (
                  <AddProjectDialog
                    onAdd={async (path) => {
                      await handleAddProject(path);
                    }}
                    onConnectRemote={(remoteRoot) => {
                      setAddProjectOpen(false);
                      void queryClient.invalidateQueries({
                        queryKey: ['switcher-projects'],
                      });
                      selectSwitchProject(remoteRoot);
                    }}
                    onClose={() => setAddProjectOpen(false)}
                    // A remote root names no folder on this disk.
                    startIn={
                      root === undefined || root === null || isRemoteRoot(root)
                        ? null
                        : parentDir(root)
                    }
                  />
                )}

                <CommandPalette
                  isOpen={navState.paletteOpen}
                  entries={paletteEntries}
                  timeline={activeProject === null ? null : planning.timeline}
                  onNavigate={navigate}
                  searchDocs={searchDocs}
                />

                {/* After the palette in the tree, so the sheet the
                      reducer stacks over it draws on top. */}
                {navState.shortcutsOpen && (
                  <ShortcutSheet
                    groups={shortcutGroups}
                    onClose={() => dispatchNav({ type: 'closeShortcuts' })}
                  />
                )}
              </div>
            </SurfaceHosts>
          </PeopleProvider>
        </SavedViewsProvider>
      </DeepLinkProvider>
    </ShellActionsProvider>
  );
}

export default App;
