import './ComingSoonView.css';

interface ComingSoonViewProps {
  title: string;
}

export function ComingSoonView({ title }: ComingSoonViewProps) {
  return (
    <div className="coming-soon-view">
      <div className="coming-soon-card">
        <h1 className="coming-soon-title">{title}</h1>
        <p className="coming-soon-text">Coming soon.</p>
      </div>
    </div>
  );
}
