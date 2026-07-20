import { agentMeta } from '../../lib/agents';
import type { Card, Session } from '../../lib/types';
import './CardTile.css';

interface CardTileProps {
  card: Card;
  linkedSession: Session | null;
  onClick: () => void;
  onDragStart: (cardId: string) => void;
}

export function CardTile({
  card,
  linkedSession,
  onClick,
  onDragStart,
}: CardTileProps) {
  return (
    <div
      className="card-tile"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', card.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart(card.id);
      }}
      onClick={onClick}
    >
      <div className="card-tile-title">{card.title}</div>
      {card.description ? (
        <div className="card-tile-description">{card.description}</div>
      ) : null}
      {linkedSession ? (
        <div className="card-tile-session">
          <span
            className={`card-tile-session-dot card-tile-session-dot-${linkedSession.status}`}
          />
          {agentMeta(linkedSession.agent).icon}{' '}
          {linkedSession.model ?? agentMeta(linkedSession.agent).label}
          {linkedSession.cost_usd > 0
            ? ` · $${linkedSession.cost_usd.toFixed(2)}`
            : ''}
        </div>
      ) : null}
    </div>
  );
}
