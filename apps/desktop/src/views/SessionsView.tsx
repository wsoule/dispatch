import { useQuery } from '@tanstack/react-query';
import { Inbox, OctagonAlert } from 'lucide-react';
import { useState } from 'react';

import { SessionDetailModal } from '../components/sessions/SessionDetailModal';
import { projectNameFor } from '../components/sessions/sessionDisplay';
import { SessionRow } from '../components/sessions/SessionRow';
import { SessionsEmptyState } from '../components/sessions/SessionsEmptyState';
import { listProjects, listSessions } from '../lib/tauri';
import { Skeleton } from '@/ui/skeleton';

export function SessionsView() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );

  const {
    data: sessions,
    isLoading,
    isError,
    refetch,
  } = useQuery({ queryKey: ['sessions'], queryFn: listSessions });

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
  });

  return (
    <div className="flex h-full flex-col gap-4">
      {isLoading && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}

      {isError && (
        <SessionsEmptyState
          icon={<OctagonAlert className="size-5" />}
          message="Couldn’t load sessions. Is the backend running?"
          tone="destructive"
          onRetry={() => void refetch()}
        />
      )}

      {!isLoading && !isError && (!sessions || sessions.length === 0) && (
        <SessionsEmptyState
          icon={<Inbox className="size-5" />}
          message="No sessions yet — start a Claude Code session in any repo and it will appear here."
        />
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
