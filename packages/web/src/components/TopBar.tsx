export type ViewMode = 'board' | 'list';

export interface TopBarProps {
  projectName: string;
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  onNewTask: () => void;
}

// App header: project identity (derived from the daemon's rootDir, not
// hardcoded), the board/list toggle, and the primary "New Task" action —
// the one place a filled accent button belongs per the design direction.
export function TopBar({
  projectName,
  view,
  onViewChange,
  onNewTask,
}: TopBarProps) {
  return (
    <header className="topbar">
      <div className="topbar__brand">
        <span className="topbar__dot" aria-hidden="true" />
        <span className="topbar__wordmark">dispatch</span>
        <span className="topbar__sep">/</span>
        <span className="topbar__project">{projectName}</span>
      </div>
      <div className="topbar__spacer" />
      <div className="view-toggle" role="group" aria-label="View">
        <button
          type="button"
          className="view-toggle__btn"
          data-active={view === 'board'}
          onClick={() => onViewChange('board')}
        >
          Board
        </button>
        <button
          type="button"
          className="view-toggle__btn"
          data-active={view === 'list'}
          onClick={() => onViewChange('list')}
        >
          List
        </button>
      </div>
      <button type="button" className="btn btn--primary" onClick={onNewTask}>
        New Task
      </button>
    </header>
  );
}
