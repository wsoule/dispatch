import './Sidebar.css';

export type View =
  | 'dashboard'
  | 'projects'
  | 'sessions'
  | 'timeline'
  | 'report'
  | 'connections'
  | 'agent-manager';

const NAV_ITEMS: {
  id: View;
  label: string;
  icon: string;
  disabled?: boolean;
}[] = [
  { id: 'dashboard', label: 'Dashboard', icon: '▦' },
  { id: 'projects', label: 'Projects', icon: '⊞' },
  { id: 'sessions', label: 'Sessions', icon: '◷' },
  { id: 'timeline', label: 'Timeline', icon: '⋮' },
  { id: 'report', label: 'Reports', icon: '▥' },
  { id: 'connections', label: 'Connections', icon: '⟳', disabled: true },
  { id: 'agent-manager', label: 'Agent Manager', icon: '▶', disabled: true },
];

interface SidebarProps {
  active: View;
  onSelect: (view: View) => void;
  footer: string;
}

export function Sidebar({ active, onSelect, footer }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">Relay</div>
      <div className="sidebar-section-label">Workspace</div>
      <nav>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            className={`sidebar-nav-item${active === item.id ? ' active' : ''}${item.disabled ? ' disabled' : ''}`}
            aria-disabled={item.disabled}
            onClick={() => onSelect(item.id)}
          >
            <span className="sidebar-nav-icon">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">{footer}</div>
    </aside>
  );
}
