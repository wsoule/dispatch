import { useState } from 'react';

import { Sidebar, type View } from './components/nav/Sidebar';
import { useDataChangedEvents } from './hooks/useDataChangedEvents';
import { ComingSoonView } from './views/ComingSoonView';
import { DashboardView } from './views/DashboardView';
import { ProjectsView } from './views/ProjectsView';
import { ReportView } from './views/ReportView';
import { SessionsView } from './views/SessionsView';
import { TasksView } from './views/TasksView';
import { TimelineView } from './views/TimelineView';

function App() {
  const [activeView, setActiveView] = useState<View>('dashboard');

  useDataChangedEvents();

  return (
    <div className="app-shell">
      <Sidebar
        active={activeView}
        onSelect={setActiveView}
        footer="Relay v0.1.0"
      />
      <main className="app-main">
        {activeView === 'dashboard' && <DashboardView />}
        {activeView === 'projects' && <ProjectsView />}
        {activeView === 'tasks' && <TasksView />}
        {activeView === 'sessions' && <SessionsView />}
        {activeView === 'timeline' && <TimelineView />}
        {activeView === 'report' && <ReportView />}
        {activeView === 'connections' && <ComingSoonView title="Connections" />}
        {activeView === 'agent-manager' && (
          <ComingSoonView title="Agent Manager" />
        )}
      </main>
    </div>
  );
}

export default App;
