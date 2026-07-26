import { useEffect, useState } from 'react';

import { DashboardView } from './DashboardView';
import { ProjectsView } from './ProjectsView';
import { ReportView } from './ReportView';
import { SessionsView } from './SessionsView';
import { TimelineView } from './TimelineView';
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs';

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

const TAB_STORAGE_KEY = 'dispatch:sessions-hub-tab';

// Remembers the last tab across restarts/nav-aways — same pattern BoardView's own
// List/Board toggle uses — so switching to another nav item and back doesn't silently reset
// straight to Dashboard. Guarded for `window` even though this is a Tauri/browser-only app
// (never SSR'd) so a stray server-side render of this module can't throw on a missing
// `localStorage`.
function readStoredTab(): SessionsTab {
  if (typeof window === 'undefined') return 'dashboard';
  const stored = window.localStorage.getItem(TAB_STORAGE_KEY);
  return TABS.some((t) => t.id === stored)
    ? (stored as SessionsTab)
    : 'dashboard';
}

/**
 * Relay's own observability plane — every view it had before this redesign (Dashboard,
 * Projects, Sessions, Timeline, Reports) — kept fully functional but demoted behind one
 * "Sessions" entry in the sidebar's global section, unified under a single tab bar instead
 * of five separate top-level nav items. This is what makes the app stop reading as
 * "Relay-with-a-Tasks-tab": Relay's surfaces are still here and still work, they're just
 * clearly the secondary, cost/history-observability plane now, not the app's front door.
 */
export function SessionsHubView() {
  const [tab, setTab] = useState<SessionsTab>(readStoredTab);

  useEffect(() => {
    window.localStorage.setItem(TAB_STORAGE_KEY, tab);
  }, [tab]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <Tabs value={tab} onValueChange={(value) => setTab(value as SessionsTab)}>
        <TabsList
          variant="line"
          className="border-border w-full justify-start gap-4 border-b p-0"
        >
          {TABS.map((t) => (
            <TabsTrigger
              key={t.id}
              value={t.id}
              className="flex-none px-0 text-[13px]"
            >
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'dashboard' && <DashboardView />}
        {tab === 'projects' && <ProjectsView />}
        {tab === 'sessions' && <SessionsView />}
        {tab === 'timeline' && <TimelineView />}
        {tab === 'report' && <ReportView />}
      </div>
    </div>
  );
}
