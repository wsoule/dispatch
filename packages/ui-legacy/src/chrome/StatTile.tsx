import './StatTile.css';

interface StatTileProps {
  value: string | number;
  label: string;
}

export function StatTile({ value, label }: StatTileProps) {
  return (
    <div className="stat-tile">
      <div className="stat-tile-value">{value}</div>
      <div className="stat-tile-label">{label}</div>
    </div>
  );
}
