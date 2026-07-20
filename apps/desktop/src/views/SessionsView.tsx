import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { listProjects, listSessions } from '../lib/tauri';
import type { ProjectSummary } from '../lib/types';
import { SessionDetailModal } from './SessionDetailModal';
import { SessionRow } from './SessionRow';
import './SessionsView.css';

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
    <div className="sessions-view">
      <div className="view-topbar">
        <h1 className="view-topbar-title">Sessions</h1>
      </div>

      {isLoading && <p className="sessions-view-status">Loading sessions…</p>}

      {isError && (
        <p className="sessions-view-status">
          Couldn't load sessions. Is the backend running?
        </p>
      )}

      {!isLoading && !isError && (!sessions || sessions.length === 0) && (
        <p className="sessions-view-status">
          No sessions yet — start a Claude Code session in any repo and it will
          appear here.
        </p>
      )}

      {!isLoading && !isError && sessions && sessions.length > 0 && (
        <div className="sessions-view-list">
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
