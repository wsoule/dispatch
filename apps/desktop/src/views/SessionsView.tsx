import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Inbox } from 'lucide-react';
import { useState } from 'react';

import { listProjects, listSessions } from '../lib/tauri';
import type { ProjectSummary } from '../lib/types';
import { SessionDetailModal } from './SessionDetailModal';
import { SessionRow } from './SessionRow';
import { Skeleton } from '@/ui/skeleton';

function projectNameFor(
  projects: ProjectSummary[] | undefined,
  projectId: string
): string {
  return projects?.find((p) => p.id === projectId)?.name ?? projectId;
}

export function SessionsView() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );

  const {
    data: sessions,
    isLoading,
    isError,
  } = useQuery({ queryKey: ['sessions'], queryFn: listSessions });

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
  });

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-foreground text-[15px] font-medium">Sessions</h1>

      {isLoading && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}

      {isError && (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <AlertCircle className="text-destructive size-5" />
          <p className="text-muted-foreground text-[13px]">
            Couldn&rsquo;t load sessions. Is the backend running?
          </p>
        </div>
      )}

      {!isLoading && !isError && (!sessions || sessions.length === 0) && (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <Inbox className="text-muted-foreground size-5" />
          <p className="text-muted-foreground max-w-sm text-[13px]">
            No sessions yet — start a Claude Code session in any repo and it
            will appear here.
          </p>
        </div>
      )}

      {!isLoading && !isError && sessions && sessions.length > 0 && (
        <div className="flex flex-col gap-2">
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              projectName={projectNameFor(projects, session.project_id)}
              onClick={() => setSelectedSessionId(session.id)}
            />
          ))}
        </div>
      )}

      <SessionDetailModal
        sessionId={selectedSessionId}
        onClose={() => setSelectedSessionId(null)}
      />
    </div>
  );
}
