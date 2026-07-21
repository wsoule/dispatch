import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';

import { CommandPalette } from './components/shell/CommandPalette';
import type { PaletteEntry } from './components/shell/CommandPalette';
import { Sidebar } from './components/shell/Sidebar';
import { CreateTaskModal } from './components/tasks/CreateTaskModal';
import { TaskPeekPanel } from './components/tasks/TaskPeekPanel';
import { useAllAgents } from './hooks/useAllAgents';
import { useDataChangedEvents } from './hooks/useDataChangedEvents';
import { useDispatchProject } from './hooks/useDispatchProject';
import { useGlobalKeyboard } from './hooks/useGlobalKeyboard';
import type { GlobalView, ProjectView } from './lib/appNav';
import { initialNavState, navReducer } from './lib/appNav';
import {
  dedupeProjectsByPath,
  filterDispatchEnabledProjects,
} from './lib/dispatchProjects';
import { hasDispatch, listProjects } from './lib/tauri';
import type { ProjectSummary } from './lib/types';
import { AllAgentsView } from './views/AllAgentsView';
import { BoardView } from './views/BoardView';
import { GetStartedView } from './views/GetStartedView';
import { PlansView } from './views/PlansView';
import { RunsView } from './views/RunsView';
import { SessionsHubView } from './views/SessionsHubView';
import { SettingsView } from './views/SettingsView';
import { TasksListView } from './views/TasksListView';

const LAST_PROJECT_STORAGE_KEY = 'dispatch:lastActiveProjectId';

function App() {
  const [navState, dispatchNav] = useReducer(navReducer, initialNavState);
  const [showCreate, setShowCreate] = useState(false);
  // Overrides whatever's in the main pane with the get-started flow, scoped to one specific
  // project — set by clicking a "no tracker" entry in the sidebar's project switcher.
  // `null` means "not focused on a specific project" (the general first-run empty state can
  // still show on its own, see `showGetStarted` below).
  const [getStartedFocus, setGetStartedFocus] = useState<ProjectSummary | null>(
    null
  );

  useDataChangedEvents();

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
  });
  // Relay's project list can carry more than one row for the same path (see
  // `dedupeProjectsByPath`'s doc comment) — collapsed to one row per path *before* anything
  // dispatch-facing (the sidebar switcher, the palette's project entries, the cross-project
  // "All Agents" fan-out) reads it, since a dispatchd sidecar is 1:1 with a path, never with
  // Relay's row id.
  const dedupedProjects = useMemo(
    () => dedupeProjectsByPath(projects ?? []),
    [projects]
  );
  const projectPaths = useMemo(
    () => dedupedProjects.map((p) => p.path),
    [dedupedProjects]
  );
  const { data: hasDispatchByPath } = useQuery({
    queryKey: ['has-dispatch-map', projectPaths],
    queryFn: async () => {
      const entries = await Promise.all(
        projectPaths.map(
          async (path) => [path, await hasDispatch(path)] as const
        )
      );
      return new Map(entries);
    },
    enabled: projects !== undefined,
  });

  const dispatchProjects = useMemo(
    () =>
      filterDispatchEnabledProjects(
        dedupedProjects,
        hasDispatchByPath ?? new Map()
      ),
    [dedupedProjects, hasDispatchByPath]
  );
  const dispatchProjectIds = useMemo(
    () => new Set(dispatchProjects.map((p) => p.id)),
    [dispatchProjects]
  );
  const otherProjects = useMemo(
    () => dedupedProjects.filter((p) => !dispatchProjectIds.has(p.id)),
    [dedupedProjects, dispatchProjectIds]
  );

  // Restores the last project this window had active (per the redesign brief's "default
  // screen on launch: the last-active dispatch-enabled project's Board") once the
  // dispatch-enabled project list resolves; falls back to the first dispatch-enabled
  // project if there's no usable persisted id, and does nothing (leaving the get-started
  // screen up) when there are none at all yet.
  useEffect(() => {
    if (navState.activeProjectId !== null || dispatchProjects.length === 0)
      return;
    let restoreId: string | null = null;
    try {
      restoreId = window.localStorage.getItem(LAST_PROJECT_STORAGE_KEY);
    } catch {
      restoreId = null;
    }
    const target =
      dispatchProjects.find((p) => p.id === restoreId) ?? dispatchProjects[0];
    dispatchNav({ type: 'selectProject', projectId: target.id });
  }, [dispatchProjects, navState.activeProjectId]);

  const activeProject =
    dispatchProjects.find((p) => p.id === navState.activeProjectId) ?? null;

  useEffect(() => {
    if (activeProject === null) return;
    try {
      window.localStorage.setItem(LAST_PROJECT_STORAGE_KEY, activeProject.id);
    } catch {
      // Persisted "last active project" is a convenience, not a correctness requirement.
    }
  }, [activeProject]);

  // Stabilized (useCallback) so `paletteEntries` below can list every handler it actually
  // calls in its dependency array and mean it, rather than reaching for an
  // `eslint-disable-next-line react-hooks/exhaustive-deps` to hide the fact that a plain
  // function declared in the component body has a new identity every render.
  const selectProject = useCallback((projectId: string) => {
    setGetStartedFocus(null);
    dispatchNav({ type: 'selectProject', projectId });
  }, []);

  const selectUninitialized = useCallback((project: ProjectSummary) => {
    setGetStartedFocus(project);
  }, []);

  const setProjectView = useCallback((view: ProjectView) => {
    setGetStartedFocus(null);
    dispatchNav({ type: 'setProjectView', view });
  }, []);

  const setGlobalView = useCallback((view: GlobalView) => {
    setGetStartedFocus(null);
    dispatchNav({ type: 'setGlobalView', view });
  }, []);

  const jumpToRun = useCallback((projectId: string, runId: string) => {
    setGetStartedFocus(null);
    dispatchNav({ type: 'selectProject', projectId });
    dispatchNav({ type: 'setProjectView', view: 'runs' });
    dispatchNav({ type: 'openRun', runId });
  }, []);

  // Moves nav state to the newly (re-)dispatched run — replaces the old
  // `useDispatchProject`-internal `setSelectedRunId(meta.id)` side effect now that
  // `navReducer`'s `activeRunId` is the single source of truth for "which run is open" (C1
  // in the phase-8 fix report).
  const onRunDispatched = useCallback(
    (runId: string) => {
      setProjectView('runs');
      dispatchNav({ type: 'openRun', runId });
    },
    [setProjectView]
  );

  const data = useDispatchProject(activeProject?.path ?? null, {
    selectedRunId: navState.activeRunId,
    onRunDispatched,
  });
  const allAgents = useAllAgents(dispatchProjects);

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
        setShowCreate(true);
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
          run: () => setShowCreate(true),
        },
        {
          id: 'action-plan-work',
          label: 'Plan work…',
          kind: 'action',
          run: () => setProjectView('plans'),
        },
        {
          id: 'go-board',
          label: 'Go to Board',
          kind: 'go to',
          run: () => setProjectView('board'),
        },
        {
          id: 'go-tasks',
          label: 'Go to Tasks',
          kind: 'go to',
          run: () => setProjectView('tasks'),
        },
        {
          id: 'go-runs',
          label: 'Go to Runs',
          kind: 'go to',
          run: () => setProjectView('runs'),
        },
        {
          id: 'go-plans',
          label: 'Go to Plans',
          kind: 'go to',
          run: () => setProjectView('plans'),
        }
      );
      for (const doc of paletteTasks) {
        entries.push({
          id: `task-${doc.meta.id}`,
          label: doc.meta.title,
          sublabel: doc.meta.id,
          kind: 'task',
          run: () => {
            setProjectView('board');
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
    for (const project of dispatchProjects) {
      entries.push({
        id: `project-${project.id}`,
        label: project.name,
        sublabel: 'switch project',
        kind: 'project',
        run: () => selectProject(project.id),
      });
    }
    return entries;
  }, [
    activeProject,
    paletteTasks,
    paletteReadyIds,
    handleDispatch,
    dispatchProjects,
    setProjectView,
    setGlobalView,
    selectProject,
  ]);

  const showGetStarted =
    getStartedFocus !== null ||
    (navState.activeProjectId === null && dispatchProjects.length === 0);

  return (
    <div className="app-shell">
      <Sidebar
        dispatchProjects={dispatchProjects}
        otherProjects={otherProjects}
        activeProjectId={navState.activeProjectId}
        section={navState.section}
        projectView={navState.projectView}
        globalView={navState.globalView}
        liveAgentCount={allAgents.liveRuns.length}
        onSelectProject={selectProject}
        onSelectUninitialized={selectUninitialized}
        onSetProjectView={setProjectView}
        onSetGlobalView={setGlobalView}
      />
      <main className="app-main">
        {showGetStarted ? (
          <GetStartedView
            projects={dedupedProjects}
            dispatchEnabledIds={dispatchProjectIds}
            focusProjectId={getStartedFocus?.id ?? null}
          />
        ) : navState.section === 'global' ? (
          <>
            {navState.globalView === 'all-agents' && (
              <AllAgentsView data={allAgents} onJumpToRun={jumpToRun} />
            )}
            {navState.globalView === 'sessions' && <SessionsHubView />}
            {navState.globalView === 'settings' && (
              <SettingsView activeProject={activeProject} data={data} />
            )}
          </>
        ) : activeProject === null ? (
          <p className="board-view-status">Loading project…</p>
        ) : (
          <>
            {navState.projectView === 'board' && (
              <BoardView
                data={data}
                onSelectTask={(taskId) =>
                  dispatchNav({ type: 'openPeek', taskId })
                }
                onNewTask={() => setShowCreate(true)}
                onPlanWork={() => setProjectView('plans')}
              />
            )}
            {navState.projectView === 'tasks' && (
              <TasksListView
                data={data}
                onSelectTask={(taskId) =>
                  dispatchNav({ type: 'openPeek', taskId })
                }
                onNewTask={() => setShowCreate(true)}
              />
            )}
            {navState.projectView === 'runs' && (
              <RunsView
                data={data}
                selectedRunId={navState.activeRunId}
                onSelectRun={(runId) => dispatchNav({ type: 'openRun', runId })}
              />
            )}
            {navState.projectView === 'plans' && (
              <PlansView data={data} projectPath={activeProject.path} />
            )}
          </>
        )}
      </main>

      {selectedDoc !== null && data.config !== null && (
        <TaskPeekPanel
          doc={selectedDoc}
          statuses={data.config.statuses}
          ready={data.readyIds.has(selectedDoc.meta.id)}
          run={data.latestRunByTaskId.get(selectedDoc.meta.id)}
          onClose={() => dispatchNav({ type: 'closePeek' })}
          onUpdate={data.handleUpdate}
          onDispatch={data.handleDispatch}
          onOpenRun={(runId) => {
            dispatchNav({ type: 'closePeek' });
            setProjectView('runs');
            dispatchNav({ type: 'openRun', runId });
          }}
        />
      )}

      {showCreate && data.config !== null && (
        <CreateTaskModal
          statuses={data.config.statuses}
          epics={data.epics}
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
  );
}

export default App;
