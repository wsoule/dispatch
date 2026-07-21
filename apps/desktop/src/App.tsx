import { useQuery } from '@tanstack/react-query';
import { Loader2, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';

import { CommandPalette } from './components/shell/CommandPalette';
import type { PaletteEntry } from './components/shell/CommandPalette';
import { Sidebar } from './components/shell/Sidebar';
import { CreateTaskModal } from './components/tasks/CreateTaskModal';
import { TaskDetailDialog } from './components/tasks/TaskDetailDialog';
import { useDataChangedEvents } from './hooks/useDataChangedEvents';
import { useDispatchProject } from './hooks/useDispatchProject';
import { useGlobalKeyboard } from './hooks/useGlobalKeyboard';
import type { GlobalView, ProjectView } from './lib/appNav';
import { initialNavState, navReducer } from './lib/appNav';
import { basename } from './lib/projectName';
import { isTerminalRunState } from './lib/runState';
import { currentProjectRoot, hasDispatch, listProjects } from './lib/tauri';
import { AllAgentsView } from './views/AllAgentsView';
import { BoardView } from './views/BoardView';
import { GetStartedView } from './views/GetStartedView';
import { PlansView } from './views/PlansView';
import { RunsView } from './views/RunsView';
import { SessionsHubView } from './views/SessionsHubView';
import { SettingsView } from './views/SettingsView';
import { TooltipProvider } from '@/ui/tooltip';

function App() {
  const [navState, dispatchNav] = useReducer(navReducer, initialNavState);
  const [showCreate, setShowCreate] = useState(false);
  // Pre-selects `CreateTaskModal`'s Status field when it's opened from a board column's or
  // list group's hover "+" button (see `BoardView`'s `onNewTask`) — `null` when opened from
  // the plain "New task" button, which leaves the modal to default to the first configured
  // status on its own.
  const [createStatus, setCreateStatus] = useState<string | null>(null);

  useDataChangedEvents();

  // The app is scoped to a single project — the one it was launched from (see
  // `commands::current_project_root`'s doc comment for the `tauri dev`-vs-packaged-app
  // resolution). This replaces the old `listProjects` + per-path `hasDispatch` fan-out, which
  // enumerated every project Relay had ever seen (100+ on a real machine, many stale/deleted)
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
      const projects = await listProjects();
      const checks = await Promise.allSettled(
        projects.map(async (p) => ((await hasDispatch(p.path)) ? p : null))
      );
      return checks
        .filter(
          (r): r is PromiseFulfilledResult<(typeof projects)[number] | null> =>
            r.status === 'fulfilled'
        )
        .map((r) => r.value)
        .filter((p): p is (typeof projects)[number] => p !== null)
        .map((p) => ({ path: p.path, name: basename(p.path) }));
    },
    enabled: switcherOpen,
    staleTime: 30_000,
    retry: false,
  });

  const selectSwitchProject = useCallback((path: string) => {
    setOverrideRoot(path);
    setSwitcherOpen(false);
    // Drop the current project's nav context so the new project opens clean on
    // its Board rather than inheriting a peek/run id from the previous one.
    dispatchNav({ type: 'selectProject', projectId: path });
  }, []);

  const {
    data: rootHasDispatch,
    isError: hasDispatchError,
    error: hasDispatchErrorDetail,
  } = useQuery({
    queryKey: ['has-dispatch', root],
    queryFn: () => {
      if (root === undefined) throw new Error('project root not resolved');
      return hasDispatch(root);
    },
    enabled: root !== undefined,
    staleTime: Infinity,
    retry: false,
  });

  const activeProject = useMemo(
    () =>
      root !== undefined && rootHasDispatch === true
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

  // Opens `CreateTaskModal`, optionally pre-set to a status — the single entry point every
  // "New task"/"+" affordance (the header button, a board column's or list group's hover "+",
  // the palette action, the global "c" shortcut) calls through, so the modal's initial status
  // is always explicit rather than a leftover from whichever column's "+" was clicked last.
  const openCreateTask = useCallback((status?: string) => {
    setCreateStatus(status ?? null);
    setShowCreate(true);
  }, []);

  // Jumps straight to the Runs view with `runId` already selected — used by both the task peek
  // panel and the (now single-project) Agents view. There is only one project to switch to, so
  // unlike the old cross-project `jumpToRun` this never needs a project id.
  const jumpToRun = useCallback((runId: string) => {
    dispatchNav({ type: 'setProjectView', view: 'runs' });
    dispatchNav({ type: 'openRun', runId });
  }, []);

  // Moves nav state to the newly (re-)dispatched run — replaces the old
  // `useDispatchProject`-internal `setSelectedRunId(meta.id)` side effect now that
  // `navReducer`'s `activeRunId` is the single source of truth for "which run is open" (C1
  // in the phase-8 fix report).
  const onRunDispatched = useCallback(
    (runId: string) => {
      selectProjectView('runs');
      dispatchNav({ type: 'openRun', runId });
    },
    [selectProjectView]
  );

  const data = useDispatchProject(activeProject?.path ?? null, {
    selectedRunId: navState.activeRunId,
    onRunDispatched,
  });

  // Every non-terminal run for this project — the "Agents" view's list and the sidebar's live
  // badge both read from this single project's own run list now, not a cross-project fan-out
  // of N daemons (the old `useAllAgents`, removed with this pivot).
  const liveRuns = useMemo(
    () => data.runs.filter((run) => !isTerminalRunState(run.state)),
    [data.runs]
  );

  useGlobalKeyboard({
    // `modalOpen` (I3) is computed inside the hook itself now, via a live DOM check for any
    // open `Modal` instance — not just `showCreate` (App.tsx's only *direct* modal), so
    // SessionDetailModal/DiffModal mounted deep inside the Sessions hub also suppress the
    // global `escape` command while open, the same as CreateTaskModal always did.
    onCommand: (command) => {
      if (command === 'open-palette') dispatchNav({ type: 'togglePalette' });
      else if (command === 'escape') dispatchNav({ type: 'escape' });
      else if (
        command === 'new-task' &&
        activeProject !== null &&
        data.client !== null
      ) {
        openCreateTask();
      }
    },
  });

  const selectedDoc =
    navState.peekTaskId !== null
      ? (data.tasks.find((t) => t.meta.id === navState.peekTaskId) ?? null)
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
  } = data;

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
          id: 'go-runs',
          label: 'Go to Runs',
          kind: 'go to',
          run: () => selectProjectView('runs'),
        },
        {
          id: 'go-plans',
          label: 'Go to Plans',
          kind: 'go to',
          run: () => selectProjectView('plans'),
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
  const showGetStarted =
    resolutionError === null && root !== undefined && rootHasDispatch === false;
  const stillResolving =
    resolutionError === null &&
    (root === undefined || rootHasDispatch === undefined);

  return (
    <TooltipProvider>
      <div className="flex h-screen overflow-hidden">
        <Sidebar
          projectName={activeProject?.name ?? null}
          projectPath={activeProject?.path ?? null}
          hasActiveProject={activeProject !== null}
          section={navState.section}
          projectView={navState.projectView}
          globalView={navState.globalView}
          liveAgentCount={liveRuns.length}
          onSetProjectView={selectProjectView}
          onSetGlobalView={setGlobalView}
          switcherOpen={switcherOpen}
          onToggleSwitcher={() => setSwitcherOpen((open) => !open)}
          switchProjects={switchProjects ?? []}
          onSelectProject={selectSwitchProject}
        />
        <main className="min-w-0 flex-1 overflow-auto p-6">
          {resolutionError !== null ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <TriangleAlert className="text-destructive size-5" />
              <p className="text-muted-foreground max-w-sm text-[13px]">
                {resolutionError}
              </p>
            </div>
          ) : stillResolving ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <Loader2 className="text-muted-foreground size-5 animate-spin" />
              <p className="text-muted-foreground text-[13px]">
                Loading project…
              </p>
            </div>
          ) : showGetStarted ? (
            <GetStartedView projectPath={root} />
          ) : navState.section === 'global' ? (
            <>
              {navState.globalView === 'all-agents' && (
                <AllAgentsView
                  liveRuns={liveRuns}
                  portLoading={data.portLoading}
                  portError={data.portError}
                  portErrorDetail={data.portErrorDetail}
                  client={data.client}
                  onRetry={data.retryEnsureDispatchd}
                  onJumpToRun={jumpToRun}
                />
              )}
              {navState.globalView === 'sessions' && <SessionsHubView />}
              {navState.globalView === 'settings' && (
                <SettingsView activeProject={activeProject} data={data} />
              )}
            </>
          ) : activeProject === null ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <Loader2 className="text-muted-foreground size-5 animate-spin" />
              <p className="text-muted-foreground text-[13px]">
                Loading project…
              </p>
            </div>
          ) : (
            <>
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
              {navState.projectView === 'runs' && (
                <RunsView
                  data={data}
                  selectedRunId={navState.activeRunId}
                  onSelectRun={(runId) =>
                    dispatchNav({ type: 'openRun', runId })
                  }
                />
              )}
              {navState.projectView === 'plans' && (
                <PlansView data={data} projectPath={activeProject.path} />
              )}
            </>
          )}
        </main>

        {selectedDoc !== null && data.config !== null && (
          <TaskDetailDialog
            doc={selectedDoc}
            statuses={data.config.statuses}
            ready={data.readyIds.has(selectedDoc.meta.id)}
            run={data.latestRunByTaskId.get(selectedDoc.meta.id)}
            runs={data.runs.filter((r) => r.taskId === selectedDoc.meta.id)}
            epics={data.epics}
            tasks={data.tasks}
            onClose={() => dispatchNav({ type: 'closePeek' })}
            onUpdate={data.handleUpdate}
            onMoveStatus={data.moveTaskStatus}
            onDispatch={data.handleDispatch}
            onOpenRun={(runId) => {
              dispatchNav({ type: 'closePeek' });
              selectProjectView('runs');
              dispatchNav({ type: 'openRun', runId });
            }}
          />
        )}

        {showCreate && data.config !== null && (
          <CreateTaskModal
            statuses={data.config.statuses}
            epics={data.epics}
            initialStatus={createStatus ?? undefined}
            onCreate={data.handleCreate}
            onClose={() => setShowCreate(false)}
          />
        )}

        <CommandPalette
          isOpen={navState.paletteOpen}
          entries={paletteEntries}
          onClose={() => dispatchNav({ type: 'closePalette' })}
        />
      </div>
    </TooltipProvider>
  );
}

export default App;
