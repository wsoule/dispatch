import './Pill.css';

type PillVariant = 'agent' | 'status' | 'tag' | 'stack';

interface PillProps {
  variant: PillVariant;
  tone?: 'green' | 'blue' | 'red' | 'amber' | 'gray' | 'accent';
  children: React.ReactNode;
}

export function Pill({ variant, tone = 'gray', children }: PillProps) {
  return (
    <span className={`pill pill-${variant} pill-tone-${tone}`}>
      {variant === 'status' && <span className="pill-dot" />}
      {children}
    </span>
  );
}
