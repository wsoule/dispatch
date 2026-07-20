import { useState } from 'react';

import type {
  BoardColumn as BoardColumnType,
  Card,
  Session,
} from '../../lib/types';
import { CardTile } from './CardTile';
import './BoardColumn.css';

interface BoardColumnProps {
  column: BoardColumnType;
  cards: Card[];
  sessionsById: Map<string, Session>;
  onCardClick: (card: Card) => void;
  onCardDrop: (cardId: string, columnId: string) => void;
  onAddCard: (columnId: string, title: string) => void;
}

/** Manual "+ Add card" only makes sense on planning columns — 'todo' or a plain (role-less)
 * user-added column. The in_progress/review/done columns are session-driven; a manual add
 * button there would let users create cards in a state that implies work already happened. */
function allowsManualAdd(role: string | null): boolean {
  return role === null || role === 'todo';
}

export function BoardColumn({
  column,
  cards,
  sessionsById,
  onCardClick,
  onCardDrop,
  onAddCard,
}: BoardColumnProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  function submitNewCard() {
    const title = newTitle.trim();
    if (title) {
      onAddCard(column.id, title);
    }
    setNewTitle('');
    setIsAdding(false);
  }

  return (
    <div
      className={`board-column${isDragOver ? ' board-column-drag-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragOver(false);
        const cardId = e.dataTransfer.getData('text/plain');
        if (cardId) onCardDrop(cardId, column.id);
      }}
    >
      <div className="board-column-header">
        <span className="board-column-name">{column.name}</span>
        <span className="board-column-count">{cards.length}</span>
      </div>

      <div className="board-column-cards">
        {cards.map((card) => (
          <CardTile
            key={card.id}
            card={card}
            linkedSession={
              card.session_id
                ? (sessionsById.get(card.session_id) ?? null)
                : null
            }
            onClick={() => onCardClick(card)}
            onDragStart={() => {}}
          />
        ))}
      </div>

      {allowsManualAdd(column.role) ? (
        isAdding ? (
          <input
            className="board-column-add-input"
            autoFocus
            value={newTitle}
            placeholder="Card title…"
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitNewCard();
              if (e.key === 'Escape') {
                setNewTitle('');
                setIsAdding(false);
              }
            }}
            onBlur={submitNewCard}
          />
        ) : (
          <button
            className="board-column-add-button"
            onClick={() => setIsAdding(true)}
          >
            + Add card
          </button>
        )
      ) : null}
    </div>
  );
}
