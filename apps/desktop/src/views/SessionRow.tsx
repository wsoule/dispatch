import { ProjectDot } from '../components/ui/ProjectDot';
import { formatRelativeTime, sessionDisplayName } from '../lib/format';
import type { Session } from '../lib/types';

interface SessionRowProps {
  session: Session;
  projectName: string;
  onClick: () => void;
}

/** Session status renders as a small colored dot rather than a filled pill, matching the
 * shared "status = colored dot" convention — green while the session is still active, a
 * muted dot once it's ended. */
function statusDotClass(status: Session['status']): string {
  return status === 'active' ? 'bg-emerald-500' : 'bg-muted-foreground/50';
}

/**
 * Single-session summary row: project + status + model on top, summary below, stats
 * (relative time / cost / tokens) on the right. Shared between `SessionsView` (flat list of
 * all sessions) and `ProjectDetail` (sessions scoped to one project) so this rendering logic
 * lives in exactly one place.
 */
export function SessionRow({ session, projectName, onClick }: SessionRowProps) {
  return (
    <button
      onClick={onClick}
      className="border-border bg-card hover:bg-accent/40 flex w-full items-center justify-between gap-4 rounded-lg border p-3 text-left transition-colors"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          <ProjectDot projectId={session.project_id} />
          <span className="text-foreground text-[13px] font-medium">
            {projectName}
          </span>
          <span className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
            <span
              className={`size-1.5 rounded-full ${statusDotClass(session.status)}`}
              aria-hidden="true"
            />
            {session.status}
          </span>
          <span className="text-muted-foreground font-mono text-[11px]">
            {session.model ?? 'unknown model'}
          </span>
        </div>
        <div className="text-muted-foreground truncate text-[13px]">
          {sessionDisplayName(session.title, session.summary)}
        </div>
      </div>
      <div className="text-muted-foreground flex flex-shrink-0 flex-col items-end gap-1 text-[11px]">
        <span>{formatRelativeTime(session.last_activity_at)}</span>
        <span className="font-mono">${session.cost_usd.toFixed(2)}</span>
        <span className="font-mono">
          {session.prompt_tokens + session.completion_tokens} tokens
        </span>
      </div>
    </button>
  );
}
