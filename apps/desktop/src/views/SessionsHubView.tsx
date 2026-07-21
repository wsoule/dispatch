import { useState } from 'react';

import { DashboardView } from './DashboardView';
import { ProjectsView } from './ProjectsView';
import { ReportView } from './ReportView';
import { SessionsView } from './SessionsView';
import { TimelineView } from './TimelineView';
import './SessionsHubView.css';

type SessionsTab =
  | 'dashboard'
  | 'projects'
  | 'sessions'
  | 'timeline'
  | 'report';

const TABS: { id: SessionsTab; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'projects', label: 'Projects' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'report', label: 'Reports' },
];

/**
 * Relay's own observability plane — every view it had before this redesign (Dashboard,
 * Projects, Sessions, Timeline, Reports) — kept fully functional but demoted behind one
 * "Sessions" entry in the sidebar's global section, unified under a single tab bar instead
 * of five separate top-level nav items. This is what makes the app stop reading as
 * "Relay-with-a-Tasks-tab": Relay's surfaces are still here and still work, they're just
 * clearly the secondary, cost/history-observability plane now, not the app's front door.
 */
export function SessionsHubView() {
  const [tab, setTab] = useState<SessionsTab>('dashboard');

  return (
    <div className="sessions-hub-view">
      <div className="sessions-hub-view-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`sessions-hub-view-tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="sessions-hub-view-body">
        {tab === 'dashboard' && <DashboardView />}
        {tab === 'projects' && <ProjectsView />}
        {tab === 'sessions' && <SessionsView />}
        {tab === 'timeline' && <TimelineView />}
        {tab === 'report' && <ReportView />}
      </div>
    </div>
  );
}
