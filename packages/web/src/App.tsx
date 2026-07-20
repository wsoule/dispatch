import type { HealthPayload } from '@dispatch/client';
import { createApiClient, useTasks } from '@dispatch/client';
import type { CreateInput, UpdatePatch } from '@dispatch/core';
import { useEffect, useMemo, useState } from 'react';

import { basename } from './basename';
import { Board } from './components/Board';
import { CreateTask } from './components/CreateTask';
import { ListView } from './components/ListView';
import { TaskDetail } from './components/TaskDetail';
import type { ViewMode } from './components/TopBar';
import { TopBar } from './components/TopBar';
import { computeBlockedIds } from './taskGraph';

// Empty string means "same origin" — dispatchd serves this app's own static
// files in production, so the common case needs no base URL at all. A
// non-empty value is the seam a Tauri desktop shell uses to point this same
// UI at a daemon running on some other port (see spec §2).
const baseUrl = import.meta.env.VITE_DISPATCH_URL ?? '';

export function App() {
  const client = useMemo(() => createApiClient(baseUrl), []);

  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [healthAttempt, setHealthAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    client
      .fetchHealth()
      .then((payload) => {
        if (!cancelled) {
          setHealth(payload);
          setHealthError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setHealthError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, healthAttempt]);

  const { tasks, config, readyIds, error, refresh } = useTasks(baseUrl);

  const [view, setView] = useState<ViewMode>('board');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const blockedIds = useMemo(() => computeBlockedIds(tasks), [tasks]);
  const epics = useMemo(
    () => tasks.filter((t) => t.meta.kind === 'epic'),
    [tasks]
  );
  const selectedDoc = useMemo(
    () => tasks.find((t) => t.meta.id === selectedId) ?? null,
    [tasks, selectedId]
  );

  // Escape closes whichever overlay is open — the drawer takes priority
  // since it can be open at the same time as nothing else, but the create
  // modal renders on top when both would otherwise be true.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (showCreate) setShowCreate(false);
      else if (selectedId !== null) setSelectedId(null);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showCreate, selectedId]);

  async function handleUpdate(id: string, patch: UpdatePatch): Promise<void> {
    await client.updateTask(id, patch);
    refresh();
  }

  async function handleCreate(input: CreateInput): Promise<void> {
    await client.createTask(input);
    refresh();
  }

  if (healthError !== null) {
    return (
      <div className="full-screen-state">
        <div className="full-screen-state__title">Daemon unreachable</div>
        <p>
          Couldn&rsquo;t reach dispatchd. Make sure it&rsquo;s running for this
          project.
        </p>
        <div className="full-screen-state__hint">dispatch serve</div>
        <button
          type="button"
          className="btn"
          onClick={() => setHealthAttempt((n) => n + 1)}
        >
          Retry
        </button>
      </div>
    );
  }

  if (health === null || config === null) {
    return <div className="full-screen-state">Loading…</div>;
  }

  if (error !== null) {
    return (
      <div className="full-screen-state">
        <div className="full-screen-state__title">
          Couldn&rsquo;t load tasks
        </div>
        <p>{error}</p>
        <button type="button" className="btn" onClick={refresh}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar
        projectName={basename(health.rootDir)}
        view={view}
        onViewChange={setView}
        onNewTask={() => setShowCreate(true)}
      />
      <main className="main">
        {tasks.length === 0 ? (
          <div className="full-screen-state">
            <div className="full-screen-state__title">No tasks yet</div>
            <p>Create the first one to get started.</p>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setShowCreate(true)}
            >
              New Task
            </button>
          </div>
        ) : view === 'board' ? (
          <Board
            tasks={tasks}
            statuses={config.statuses}
            readyIds={readyIds}
            blockedIds={blockedIds}
            onSelect={setSelectedId}
          />
        ) : (
          <ListView
            tasks={tasks}
            statuses={config.statuses}
            readyIds={readyIds}
            blockedIds={blockedIds}
            onSelect={setSelectedId}
          />
        )}
      </main>
      <TaskDetail
        doc={selectedDoc}
        statuses={config.statuses}
        onClose={() => setSelectedId(null)}
        onUpdate={handleUpdate}
      />
      {showCreate && (
        <CreateTask
          statuses={config.statuses}
          epics={epics}
          onCreate={handleCreate}
          onClose={() => setShowCreate(false)}
        />
      )}
    </div>
  );
}
