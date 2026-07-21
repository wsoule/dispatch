import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, FolderGit2, OctagonAlert } from 'lucide-react';
import { useState } from 'react';

import { listProjects } from '../lib/tauri';
import { ProjectCard } from './ProjectCard';
import { ProjectDetail } from './ProjectDetail';
import { Button } from '@/ui/button';
import { Skeleton } from '@/ui/skeleton';

export function ProjectsView() {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null
  );

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(18.5rem,1fr))] gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-32 rounded-lg" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 pt-24 text-center">
        <OctagonAlert className="text-destructive size-5" />
        <p className="text-muted-foreground text-[13px]">
          Couldn&rsquo;t load projects. Is the backend running?
        </p>
        <Button variant="secondary" size="sm" onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 pt-24 text-center">
        <FolderGit2 className="text-muted-foreground size-5" />
        <p className="text-muted-foreground max-w-sm text-[13px]">
          No projects yet — start a Claude Code session in any repo and it will
          appear here.
        </p>
      </div>
    );
  }

  const selectedProject =
    data.find((project) => project.id === selectedProjectId) ?? null;

  if (selectedProject) {
    return (
      <div className="flex flex-col gap-4">
        <button
          type="button"
          onClick={() => setSelectedProjectId(null)}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 self-start text-[13px] transition-colors"
        >
          <ArrowLeft className="size-3.5" />
          Back to projects
        </button>
        <ProjectDetail project={selectedProject} />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(18.5rem,1fr))] gap-4">
      {data.map((project) => (
        <ProjectCard
          key={project.id}
          project={project}
          onClick={() => setSelectedProjectId(project.id)}
        />
      ))}
    </div>
  );
}
