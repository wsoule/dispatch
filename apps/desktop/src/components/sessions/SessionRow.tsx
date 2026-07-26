import { formatRelativeTime, sessionDisplayName } from '../../lib/format';
import { modelDisplayName } from '../../lib/models';
import type { Session } from '../../lib/types';
import { ProjectDot } from '../ui/ProjectDot';
import { statusDotClass } from './sessionDisplay';

interface SessionRowProps {
  session: Session;
  projectName: string;
  onClick: () => void;
}

/**
 * Single-session summary row: project + status + model on top, summary below, stats
 * (relative time / cost / tokens) on the right. Used by the Sessions hub's session list
 * (`SessionsHubView`), optionally filtered to one project, so this rendering logic lives in
 * exactly one place.
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
            {modelDisplayName(session.model) ?? 'unknown model'}
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
