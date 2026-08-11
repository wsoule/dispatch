import type { TaskDoc } from '@dispatch/core/browser';
import { useQuery } from '@tanstack/react-query';
import type { Update } from '@tauri-apps/plugin-updater';
import { Plus, TriangleAlert } from 'lucide-react';
import type { CSSProperties } from 'react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useState,
} from 'react';

import { AddProjectDialog } from './components/shell/AddProjectDialog';
import { BrainDumpFab } from './components/shell/BrainDumpFab';
import { CommandPalette } from './components/shell/CommandPalette';
import type { PaletteEntry } from './components/shell/CommandPalette';
import { ErrorBoundary } from './components/shell/ErrorBoundary';
import { InboxPanel } from './components/shell/InboxPanel';
import { LiveRail, useLiveRailCollapsed } from './components/shell/LiveRail';
import { Sidebar, useSidebarCollapsed } from './components/shell/Sidebar';
import { PROJECT_VIEW_ORDER } from './components/shell/Sidebar';
import { useToasts } from './components/shell/Toasts';
import { UpdateBanner } from './components/shell/UpdateBanner';
import { AiTaskComposer } from './components/tasks/AiTaskComposer';
import { CreateTaskModal } from './components/tasks/CreateTaskModal';
import type { TaskDetailPanelProps } from './components/tasks/detail';
import { TaskPeekDialog } from './components/tasks/TaskPeekDialog';
import { useDataChangedEvents } from './hooks/useDataChangedEvents';
import { useDispatchProject } from './hooks/useDispatchProject';
import { useGlobalKeyboard } from './hooks/useGlobalKeyboard';
import { useWardenSession } from './hooks/useWardenSession';
import { withActionFeedback } from './lib/actionFeedback';
import type { GlobalView, ProjectView, TaskTab } from './lib/appNav';
import { initialNavState, navReducer } from './lib/appNav';
import { hideArchivedRuns } from './lib/archiveFilter';
import type { InboxTarget } from './lib/inbox';
import { unreadCount } from './lib/inbox';
import { buildInbox } from './lib/inboxQueue';
import { landingNavBadge } from './lib/landingView';
import { isLinearConfigured } from './lib/linearSettings';
import { resolveExecuteModel } from './lib/models';
import { basename } from './lib/projectName';
import { prNumberFromUrl } from './lib/reviewTarget';
import { isTerminalRunState } from './lib/runState';
import {
  addProject,
  currentProjectRoot,
  hasDispatch,
  listProjects,
  listRegisteredProjects,
  touchProjectOpened,
} from './lib/tauri';
import { checkForUpdate } from './lib/updater';
import { AllAgentsView } from './views/AllAgentsView';
import { BoardView } from './views/BoardView';
import { BrainDumpView } from './views/BrainDumpView';
import { BranchesView } from './views/BranchesView';
import { DraftView } from './views/DraftView';
import { GetStartedView } from './views/GetStartedView';
import { ImpactView } from './views/ImpactView';
import { InboxView } from './views/InboxView';
import { LandingTableView } from './views/LandingTableView';
import { OverviewView } from './views/OverviewView';
import { PlansView } from './views/PlansView';
import { PrReviewView } from './views/PrReviewView';
import { SessionsHubView } from './views/SessionsHubView';
import { SettingsView } from './views/SettingsView';
import { TaskView } from './views/TaskView';
import { WardenView } from './views/WardenView';
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
  // Pre-selects `CreateTaskModal`'s Status field from a board/list "+" button; `null` leaves
  // it to default to the first configured status.
  const [createStatus, setCreateStatus] = useState<string | null>(null);
  // Whether the notification inbox popover (the bell in Sidebar's global section) is open —
  // see toggleInbox below for why opening it also marks everything read.
  const [inboxOpen, setInboxOpen] = useState(false);
  // The AI task composer, a dialog rather than a screen — open state lives here (not in
  // `navState`) so it renders on top of whatever view is underneath instead of replacing it.
  const [aiComposerOpen, setAiComposerOpen] = useState(false);

  // The left rail's collapsed state, owned here because `SidebarProvider` wraps the whole
  // shell row; `Sidebar` reads it back through `useSidebar`. Persistence lives with the rail.
  const [sidebarCollapsed, setSidebarCollapsed] = useSidebarCollapsed();
  // The live-agents rail's collapsed state, owned here for the same reason: the rail is a
  // sibling of `<main>` in the shell row, not something a view can size for itself.
  const [liveRailCollapsed, setLiveRailCollapsed] = useLiveRailCollapsed();
  // Text handed to the planner from elsewhere (Brain dump's "hand it to the planner", or one
  // inbox item's "plan it"). Keyed into PlansView so a second hand-off with different text
  // remounts the composer rather than being swallowed by its existing state.
  const [planSeed, setPlanSeed] = useState<string | null>(null);

  // Auto-update: check GitHub's `latest.json` once after mount (non-blocking —
  // `checkForUpdate` is a no-op outside Tauri and swallows its own errors), and
  // if a newer signed release is published, offer a dismissible banner. Dismissal
  // is session-only; the next launch re-checks. `void` because the effect body
  // can't be async and the result is stored via `setPendingUpdate`.
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  useEffect(() => {
    void checkForUpdate().then((update) => {
      if (update !== null) setPendingUpdate(update);
    });
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

  const setGlobalView = useCallback((view: GlobalView) => {
    dispatchNav({ type: 'setGlobalView', view });
  }, []);

  // Opens the full-page task creator, optionally pre-set to a status — the single entry point
  // every "New task"/"+" affordance (the header button, a board column's or list group's hover
  // "+", the palette action, the global "c" shortcut) calls through, so the creator's initial
  // status is always explicit rather than a leftover from whichever column's "+" was clicked
  // last. Describing the task in natural language is the primary path now; the structured
  // modal below is the quick-add fallback.
  const openCreateTask = useCallback((status?: string) => {
    setCreateStatus(status ?? null);
    dispatchNav({ type: 'openNewTask' });
  }, []);

  // The structured quick-add fallback: `CreateTaskModal`, unchanged, for when you already know
  // the exact fields and don't want to spend an agent round-trip describing them. Reachable
  // from the palette and from the full-page creator's own "Quick add…" button.
  const openQuickAddTask = useCallback((status?: string) => {
    setCreateStatus(status ?? null);
    setShowCreate(true);
  }, []);

  // Moves nav state to the newly (re-)dispatched run. The task view is the only run surface
  // now, and a run that has just been created is live, so it opens on Chat.
  const onRunDispatched = useCallback((runId: string, taskId: string) => {
    dispatchNav({ type: 'openTask', taskId, tab: 'chat', runId });
  }, []);

  const toasts = useToasts();

  const rawData = useDispatchProject(activeProject?.path ?? null, {
    selectedRunId: navState.activeRunId,
    onRunDispatched,
  });

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
        (message) => toasts.push({ title: message, tone: 'success' })
      ),
    [rawData, toasts]
  );

  // The warden chat's session — mounted here, not inside WardenView, so the
  // open conversation survives switching tabs. Uses `rawData`'s client/port
  // directly (its errors surface in the view's own transcript rows, not as
  // action-feedback toasts); useDispatchProject's WS handler invalidates its
  // record query on `warden.changed`.
  const warden = useWardenSession(
    rawData.client,
    rawData.port,
    activeProject?.path ?? null
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

  // How many runs the archive filter is holding back, computed off the *unfiltered* list so
  // the All-agents toggle can still say what turning it on would reveal while it is already
  // on (`visibleRuns` is the full list in that case, and would report zero).
  const archivedRunCount = useMemo(() => {
    const archivedTaskIds = new Set(data.archivedTasks.map((t) => t.meta.id));
    return (
      data.runs.length - hideArchivedRuns(data.runs, archivedTaskIds).length
    );
  }, [data.runs, data.archivedTasks]);

  // Everything the Inbox view shows — the Review queue plus any run stalled
  // on an approval or a question. See `buildInbox`.
  const inboxData = useMemo(
    () => buildInbox(data.runs, data.repoPrs ?? [], data.openQuestions),
    [data.runs, data.repoPrs, data.openQuestions]
  );

  useGlobalKeyboard({
    // `modalOpen` (I3) is computed inside the hook itself now, via a live DOM check for any
    // open `Modal` instance — not just `showCreate` (App.tsx's only *direct* modal), so
    // SessionDetailModal/DiffModal mounted deep inside the Sessions hub also suppress the
    // global `escape` command while open, the same as CreateTaskModal always did.
    onCommand: (command) => {
      if (command === 'open-palette') dispatchNav({ type: 'togglePalette' });
      else if (command === 'escape') dispatchNav({ type: 'escape' });
      else if (command === 'nav-back') dispatchNav({ type: 'back' });
      else if (command === 'nav-forward') dispatchNav({ type: 'forward' });
      else if (command.startsWith('goto-')) {
        // Position in the rail, not an id — the numbers stay learnable because
        // they match what the sidebar prints next to each entry.
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
    readyIds: paletteReadyIds,
    handleDispatch,
    notificationInbox,
    markNotificationInboxRead,
  } = data;

  // Opens/closes the inbox popover. Opening it marks every entry read in one step (not
  // per-entry, which would be more distracting than useful) — see inbox.ts's markAllRead.
  const toggleInbox = useCallback(() => {
    setInboxOpen((open) => {
      const next = !open;
      if (next) markNotificationInboxRead();
      return next;
    });
  }, [markNotificationInboxRead]);

  // Stable identity for InboxPanel's onClose — that prop drives its outside-click/Escape
  // listener effect, so an inline arrow here would tear down and re-add those `document`
  // listeners on every App render instead of just when the panel opens/closes.
  const closeInbox = useCallback(() => setInboxOpen(false), []);

  // Click-through for a notification row: a run transition opens that run's task, anything
  // queue-wide lands on the Inbox, which is where "what needs me" now lives.
  // Also marks the whole inbox read again: an entry can arrive while the panel is already
  // open (opening only marks-read at that instant), and without this a fresh unread badge
  // would linger after the user just acted on the newest entry.
  const navigateFromInbox = useCallback(
    (target: InboxTarget) => {
      if (target.kind === 'task') {
        // The peek panel overlays whichever view is active, so this doesn't
        // need a view switch the way the run/queue targets below do.
        dispatchNav({ type: 'openPeek', taskId: target.taskId });
        markNotificationInboxRead();
        setInboxOpen(false);
        return;
      }
      if (target.kind === 'draft') {
        dispatchNav({ type: 'openDraft', draftId: target.draftId });
        markNotificationInboxRead();
        setInboxOpen(false);
        return;
      }
      if (target.kind === 'plan') {
        // Plans render one conversation at a time, so the view itself is the
        // destination — there is no per-plan id to select once you are there.
        selectProjectView('plans');
        markNotificationInboxRead();
        setInboxOpen(false);
        return;
      }
      if (target.kind === 'run') {
        jumpToRun(target.runId);
      } else {
        // {kind:'queue'}/{kind:'runs-page'}: no one run to point at, so both
        // land on the Inbox, which lists everything waiting and the merge
        // queue underneath it.
        selectProjectView('inbox');
      }
      markNotificationInboxRead();
      setInboxOpen(false);
    },
    [selectProjectView, markNotificationInboxRead, dispatchNav, jumpToRun]
  );

  const paletteEntries = useMemo<PaletteEntry[]>(() => {
    const entries: PaletteEntry[] = [];

    if (activeProject !== null) {
      entries.push(
        {
          id: 'action-new-task',
          label: 'New task',
          kind: 'action',
          run: () => openCreateTask(),
        },
        {
          id: 'action-quick-add-task',
          label: 'Quick add task…',
          kind: 'action',
          run: () => openQuickAddTask(),
        },
        {
          id: 'action-plan-work',
          label: 'Plan work…',
          kind: 'action',
          run: () => selectProjectView('plans'),
        },
        {
          id: 'go-tasks',
          label: 'Go to Tasks',
          kind: 'go to',
          run: () => selectProjectView('board'),
        },
        {
          id: 'go-inbox',
          label: 'Go to Inbox',
          kind: 'go to',
          run: () => selectProjectView('inbox'),
        },
        {
          id: 'go-plans',
          label: 'Go to Plans',
          kind: 'go to',
          run: () => selectProjectView('plans'),
        },
        {
          id: 'go-landing',
          label: 'Go to Landing',
          kind: 'go to',
          run: () => selectProjectView('landing'),
        }
      );
      for (const doc of paletteTasks) {
        entries.push({
          id: `task-${doc.meta.id}`,
          label: doc.meta.title,
          sublabel: doc.meta.id,
          kind: 'task',
          run: () => {
            selectProjectView('board');
            dispatchNav({ type: 'openPeek', taskId: doc.meta.id });
          },
        });
        if (paletteReadyIds.has(doc.meta.id)) {
          entries.push({
            id: `dispatch-${doc.meta.id}`,
            label: `Dispatch ${doc.meta.title}`,
            sublabel: doc.meta.id,
            kind: 'action',
            run: () => void handleDispatch(doc.meta.id),
          });
        }
      }
    }

    entries.push(
      {
        id: 'go-all-agents',
        label: 'Go to All Agents',
        kind: 'go to',
        run: () => setGlobalView('all-agents'),
      },
      {
        id: 'go-sessions',
        label: 'Go to Sessions',
        kind: 'go to',
        run: () => setGlobalView('sessions'),
      },
      {
        id: 'go-warden',
        label: 'Go to Warden',
        kind: 'go to',
        run: () => setGlobalView('warden'),
      },
      {
        id: 'go-settings',
        label: 'Go to Settings',
        kind: 'go to',
        run: () => setGlobalView('settings'),
      }
    );
    return entries;
  }, [
    activeProject,
    paletteTasks,
    paletteReadyIds,
    handleDispatch,
    selectProjectView,
    setGlobalView,
    openCreateTask,
    openQuickAddTask,
  ]);

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

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col overflow-hidden">
        {pendingUpdate !== null && !updateDismissed && (
          <UpdateBanner
            update={pendingUpdate}
            onDismiss={() => setUpdateDismissed(true)}
          />
        )}
        <SidebarProvider
          open={!sidebarCollapsed}
          onOpenChange={(open) => setSidebarCollapsed(!open)}
          // The rail's widths, unchanged from the hand-rolled version it replaced: 15rem
          // expanded, a 3.5rem icon strip collapsed.
          style={
            {
              '--sidebar-width': '15rem',
              '--sidebar-width-icon': '3.5rem',
            } as CSSProperties
          }
          // `relative` is what keeps the rail inside this row rather than pinned to the
          // viewport, so an update banner above it is never covered.
          className="relative min-h-0 flex-1 overflow-hidden"
        >
          <Sidebar
            projectName={activeProject?.name ?? null}
            projectPath={activeProject?.path ?? null}
            hasActiveProject={activeProject !== null}
            section={navState.section}
            projectView={navState.projectView}
            globalView={navState.globalView}
            liveAgentCount={liveRuns.length}
            spendToday={todaySpend}
            badges={{
              board: data.readyIds.size,
              inbox: inboxData.review.length + inboxData.waiting.length,
              landing:
                data.landing !== null ? landingNavBadge(data.landing) : 0,
            }}
            unreadCount={unreadCount(data.notificationInbox)}
            onToggleInbox={toggleInbox}
            drafts={data.drafts}
            onOpenDraft={(draftId) =>
              dispatchNav({ type: 'openDraft', draftId })
            }
            onDismissDraft={(id) => void data.handleDismissDraft(id)}
            onSetProjectView={selectProjectView}
            onSetGlobalView={setGlobalView}
            switcherOpen={switcherOpen}
            onToggleSwitcher={() => setSwitcherOpen((open) => !open)}
            switchProjects={switchProjects ?? []}
            onSelectProject={selectSwitchProject}
            syncStatus={data.syncStatus}
            onDisableAutoCommit={() =>
              void data.handleUpdateConfig({ autoCommit: false })
            }
            noProjectYet={noProjectYet}
            onAddProject={() => {
              setSwitcherOpen(false);
              setAddProjectOpen(true);
            }}
          />
          <main className="min-w-0 flex-1 overflow-auto p-6">
            <ErrorBoundary label="this page">
              {resolutionError !== null ? (
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
                      Add a local folder or clone a repository from GitHub to
                      get started.
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
              ) : navState.section === 'global' ? (
                <>
                  {navState.globalView === 'all-agents' && (
                    <AllAgentsView
                      // `visibleRuns`, not `runs`: this is the run *list* the archive filter
                      // was built for, and the only surface left that can unarchive one.
                      runs={data.visibleRuns}
                      // The non-run agents (planners, enrich, drafts, wardens) — archiving
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
                  {navState.globalView === 'sessions' && <SessionsHubView />}
                  {navState.globalView === 'warden' && (
                    <WardenView
                      data={data}
                      warden={warden}
                      projectName={activeProject?.name ?? null}
                    />
                  )}
                  {navState.globalView === 'settings' && (
                    <SettingsView activeProject={activeProject} data={data} />
                  )}
                </>
              ) : activeProject === null ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                  <Spinner className="text-muted-foreground size-5" />
                  <EmptyState message="Loading project…" className="p-0" />
                </div>
              ) : (
                <>
                  {navState.projectView === 'overview' && (
                    <OverviewView
                      data={data}
                      projectName={activeProject?.name ?? null}
                      onOpenRun={jumpToRun}
                      onReviewRun={(runId) => {
                        const run = data.runs.find((r) => r.id === runId);
                        if (run !== undefined) {
                          openTaskView(run.taskId, 'diff', run.id);
                        }
                      }}
                      onGoToBoard={() => selectProjectView('board')}
                    />
                  )}
                  {navState.projectView === 'inbox' && (
                    <InboxView
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
                      data={data}
                      onSelectTask={(taskId) =>
                        dispatchNav({ type: 'openPeek', taskId })
                      }
                      onNewTask={openCreateTask}
                      onPlanWork={() => selectProjectView('plans')}
                    />
                  )}
                  {navState.projectView === 'task' &&
                    navState.activeTaskId !== null &&
                    data.config !== null && (
                      <TaskView
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
                            data.runs.find((r) => r.id === runId)?.prUrl
                          );
                          if (number !== null) {
                            dispatchNav({ type: 'openPr', number });
                          }
                        }}
                        onOpenImpact={(subject) =>
                          dispatchNav({ type: 'openImpact', subject })
                        }
                      />
                    )}
                  {navState.projectView === 'branches' && (
                    <BranchesView
                      data={data}
                      onOpenRun={jumpToRun}
                      onOpenImpact={(subject) =>
                        dispatchNav({ type: 'openImpact', subject })
                      }
                    />
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
                      data={data}
                      projectPath={activeProject.path}
                      initialPrompt={planSeed ?? undefined}
                      key={planSeed ?? 'plans'}
                    />
                  )}
                  {navState.projectView === 'draft' &&
                    (activeDraft !== null && data.config !== null ? (
                      <DraftView
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
                              onClick={() => selectProjectView('board')}
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

          {/* The live-agents rail, kept in the corner across every project screen — unlike the
              old MiniOverview, it never hides itself: a row per running agent stays put even
              when nothing needs a human, and the attention strip is the only part that comes
              and goes. Collapsing narrows it to a strip (the attention count survives) rather
              than removing it, which is what keeps a narrow window's Diff column readable.
              Project scope only — the global views have no runs to show. */}
          {navState.section === 'project' && activeProject !== null && (
            <LiveRail
              runs={data.runs}
              repoPrs={data.repoPrs ?? []}
              openQuestions={data.openQuestions}
              onOpenTask={openTaskView}
              onOpenInbox={() => selectProjectView('inbox')}
              collapsed={liveRailCollapsed}
              onSetCollapsed={setLiveRailCollapsed}
            />
          )}
        </SidebarProvider>

        {/* The quick-capture brain button, pinned bottom-right on every project screen except
            Brain dump itself (which has the full composer). Gated on a live daemon client:
            the raw capture handler silently no-ops when `client` is null, and a capture that
            quietly drops the thought is worse than no button. */}
        {navState.section === 'project' &&
          navState.projectView !== 'brain-dump' &&
          activeProject !== null &&
          data.client !== null && (
            <BrainDumpFab
              onCapture={rawData.handleCaptureInbox}
              onOpenBrainDump={() => selectProjectView('brain-dump')}
            />
          )}

        {selectedDoc !== null && data.config !== null && (
          // Remount per task so per-task state (model choice, in-flight dispatch) can't leak across stack-rail navigation.
          <TaskPeekDialog
            key={selectedDoc.meta.id}
            {...buildTaskPanelProps(selectedDoc)}
            onClose={() => dispatchNav({ type: 'closePeek' })}
            onExpand={() => openTaskView(selectedDoc.meta.id)}
          />
        )}

        {showCreate && data.config !== null && (
          <CreateTaskModal
            statuses={data.config.statuses}
            epics={data.epics}
            initialStatus={createStatus ?? undefined}
            onCreate={(input) => data.handleCreate(input)}
            onClose={() => setShowCreate(false)}
          />
        )}

        {aiComposerOpen && (
          <AiTaskComposer
            data={data}
            onStartDraft={rawData.handleStartDraft}
            onQuickAdd={() => {
              setAiComposerOpen(false);
              openQuickAddTask(createStatus ?? undefined);
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

        {inboxOpen && (
          <InboxPanel
            entries={notificationInbox.entries}
            onNavigate={navigateFromInbox}
            onMarkAllRead={markNotificationInboxRead}
            onClose={closeInbox}
          />
        )}
      </div>
    </TooltipProvider>
  );
}

export default App;
