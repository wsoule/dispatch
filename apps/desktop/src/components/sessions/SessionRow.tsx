import { formatRelativeTime, sessionDisplayName } from '../../lib/format';
import { modelDisplayName } from '../../lib/models';
import type { Session } from '../../lib/types';
import { TaskRow, type TaskRowState } from '@/ui/ai/task-rows';

interface SessionRowProps {
  session: Session;
  projectName: string;
  onClick: () => void;
}

// A Claude Code session has only two states (`active`/`ended`) — no fail/waiting concept the
// way a Dispatch run does — so it maps onto just two of `TaskRow`'s five: a still-active
// session reads as `running` (pulsing dot, shimmering detail line), an ended one as `done`.
function sessionTaskRowState(status: Session['status']): TaskRowState {
  return status === 'active' ? 'running' : 'done';
}

/**
 * Single-session summary row, rebuilt on `TaskRow`: project name as the title, model as the
 * `agent` chip, the session's own title/summary as the shimmering `detail` line, cost as the
 * trailing `progress` figure, and relative last-activity time as `elapsedLabel`. Used by the
 * Sessions hub's session list (`SessionsHubView`), optionally filtered to one project, so this
 * rendering logic lives in exactly one place. Token counts, shown in the pre-reskin row, don't
 * fit `TaskRow`'s slots and are dropped — full detail is one click away in
 * `SessionDetailModal`.
 */
export function SessionRow({ session, projectName, onClick }: SessionRowProps) {
  return (
    <TaskRow
      title={projectName}
      agent={modelDisplayName(session.model) ?? 'unknown model'}
      state={sessionTaskRowState(session.status)}
      detail={sessionDisplayName(session.title, session.summary)}
      progress={`$${session.cost_usd.toFixed(2)}`}
      elapsedLabel={formatRelativeTime(session.last_activity_at)}
      onClick={onClick}
    />
  );
}
