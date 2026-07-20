import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { filterDispatchEnabledProjects } from '../lib/dispatchProjects';
import { hasDispatch, listProjects } from '../lib/tauri';
import { ProjectCard } from './ProjectCard';
import { ProjectDetail } from './ProjectDetail';
import './TasksView.css';

/** Global "Tasks" nav item: lists every project that has a `.dispatch/` tracker (Relay's
 * project list ∩ has-.dispatch, per the plan), then opens the same `ProjectDetail` a project
 * card elsewhere in the app would, jumped straight to its Tasks tab. */
export function TasksView() {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null
  );

  const {
    data: projects,
    isLoading: projectsLoading,
    isError: projectsError,
  } = useQuery({ queryKey: ['projects'], queryFn: listProjects });

  // Depends on `projects` (each project's path is what `has_dispatch` checks), so it's
  // gated on that query having resolved. Keyed by the actual path list rather than just
  // `['has-dispatch-map']` so a change in which projects exist re-runs this.
  const projectPaths = projects?.map((p) => p.path) ?? [];
  const {
    data: hasDispatchByPath,
    isLoading: flagsLoading,
    isError: flagsError,
  } = useQuery({
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

  if (projectsLoading || flagsLoading) {
    return <p className="tasks-view-status">Loading projects…</p>;
  }

  if (projectsError) {
    return (
      <p className="tasks-view-status">
        Couldn't load projects. Is the backend running?
      </p>
    );
  }

  // A distinct error state from the "no dispatch-enabled projects" empty state below —
  // without this, a failed has-dispatch batch (`hasDispatchByPath` stays `undefined`) falls
  // through `filterDispatchEnabledProjects`'s default-to-empty-Map behavior and renders the
  // same "run dispatch init" message a genuinely empty project list would, hiding a real
  // fetch failure behind what looks like guidance for a first-time setup.
  if (flagsError) {
    return (
      <p className="tasks-view-status">
        Couldn't check which projects have a task tracker. Is the backend
        running?
      </p>
    );
  }

  const dispatchProjects = filterDispatchEnabledProjects(
    projects ?? [],
    hasDispatchByPath ?? new Map()
  );

  const selectedProject =
    dispatchProjects.find((p) => p.id === selectedProjectId) ?? null;

  if (selectedProject) {
    return (
      <div className="tasks-view-detail-page">
        <button
          className="tasks-view-back"
          onClick={() => setSelectedProjectId(null)}
        >
          ← Back to Tasks
        </button>
        <ProjectDetail project={selectedProject} initialTab="tasks" />
      </div>
    );
  }

  if (dispatchProjects.length === 0) {
    return (
      <p className="tasks-view-status">
        No dispatch-enabled projects yet — run <code>dispatch init</code> in a
        project to start tracking tasks there.
      </p>
    );
  }

  return (
    <div className="tasks-view-grid">
      {dispatchProjects.map((project) => (
        <ProjectCard
          key={project.id}
          project={project}
          onClick={() => setSelectedProjectId(project.id)}
        />
      ))}
    </div>
  );
}
