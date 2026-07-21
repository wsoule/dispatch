import { Plus } from 'lucide-react';
import { useState } from 'react';

import type {
  BoardColumn as BoardColumnType,
  Card,
  Session,
} from '../../lib/types';
import { CardTile } from './CardTile';
import { cn } from '@/lib/utils';
import { Input } from '@/ui/input';

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
      className={cn(
        'flex max-h-full w-[17.5rem] shrink-0 flex-col gap-2 rounded-lg p-3 transition-colors duration-150',
        isDragOver ? 'bg-accent/60' : 'bg-muted/40'
      )}
    >
      <div className="flex items-center justify-between px-1">
        <span className="text-foreground text-[13px] font-medium">
          {column.name}
        </span>
        <span className="text-muted-foreground font-mono text-[11px]">
          {cards.length}
        </span>
      </div>

      <div className="flex min-h-10 flex-col gap-2 overflow-y-auto">
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
          <Input
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
            className="h-8 text-[13px]"
          />
        ) : (
          <button
            type="button"
            onClick={() => setIsAdding(true)}
            className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 rounded-md px-1 py-1.5 text-left text-[13px] transition-colors"
          >
            <Plus className="size-3.5" />
            Add card
          </button>
        )
      ) : null}
    </div>
  );
}
