import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { listProjects } from '../lib/tauri';
import { ProjectCard } from './ProjectCard';
import { ProjectDetail } from './ProjectDetail';
import './ProjectsView.css';

export function ProjectsView() {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null
  );

  const { data, isLoading, isError } = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
  });

  if (isLoading) {
    return <p className="projects-view-status">Loading projects…</p>;
  }

  if (isError) {
    return (
      <p className="projects-view-status">
        Couldn't load projects. Is the backend running?
      </p>
    );
  }

  if (!data || data.length === 0) {
    return (
      <p className="projects-view-status">
        No projects yet — start a Claude Code session in any repo and it will
        appear here.
      </p>
    );
  }

  const selectedProject =
    data.find((project) => project.id === selectedProjectId) ?? null;

  if (selectedProject) {
    return (
      <div className="projects-view-detail-page">
        <button
          className="projects-view-back"
          onClick={() => setSelectedProjectId(null)}
        >
          ← Back to projects
        </button>
        <ProjectDetail project={selectedProject} />
      </div>
    );
  }

  return (
    <>
      <div className="projects-view-grid">
        {data.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            onClick={() => setSelectedProjectId(project.id)}
          />
        ))}
      </div>
    </>
  );
}
