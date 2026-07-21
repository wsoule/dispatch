import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  createCard,
  createColumn,
  deleteCard,
  getBoard,
  launchOrAttachSession,
  linkSessionToCard,
  listSessions,
  moveCard,
  updateCard,
} from '../../lib/tauri';
import type { Card } from '../../lib/types';
import { BoardColumn } from './BoardColumn';
import { CardModal } from './CardModal';
import { Input } from '@/ui/input';
import { Skeleton } from '@/ui/skeleton';

interface ProjectBoardProps {
  projectId: string;
}

/** Kanban board for a single project — the columns/cards half of what used to be the
 * standalone `BoardView`, minus its project picker, so it can be embedded directly in
 * `ProjectDetail`. */
export function ProjectBoard({ projectId }: ProjectBoardProps) {
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [isAddingColumn, setIsAddingColumn] = useState(false);
  const [newColumnName, setNewColumnName] = useState('');

  const { data: sessions } = useQuery({
    queryKey: ['sessions'],
    queryFn: listSessions,
  });

  const { data: boardData, isLoading } = useQuery({
    queryKey: ['board', projectId],
    queryFn: () => getBoard(projectId),
  });

  const sessionsById = useMemo(
    () => new Map((sessions ?? []).map((s) => [s.id, s])),
    [sessions]
  );

  // Sessions on this project that aren't already spoken for by another card — the candidate
  // list a card's "link to session" dropdown offers.
  const linkableSessions = useMemo(() => {
    if (!boardData || !sessions) return [];
    const linkedSessionIds = new Set(
      boardData.cards.map((c) => c.session_id).filter(Boolean)
    );
    return sessions.filter(
      (s) => s.project_id === projectId && !linkedSessionIds.has(s.id)
    );
  }, [boardData, sessions, projectId]);

  const selectedCard: Card | null =
    boardData?.cards.find((c) => c.id === selectedCardId) ?? null;

  if (isLoading || !boardData) {
    return (
      <div className="flex gap-4 overflow-x-auto pb-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-64 w-[17.5rem] shrink-0 rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-4 overflow-x-auto pb-4">
        {boardData.columns.map((column) => (
          <BoardColumn
            key={column.id}
            column={column}
            cards={boardData.cards.filter((c) => c.column_id === column.id)}
            sessionsById={sessionsById}
            onCardClick={(card) => setSelectedCardId(card.id)}
            onCardDrop={(cardId, columnId) => {
              const card = boardData.cards.find((c) => c.id === cardId);
              if (card?.column_id === columnId) return;
              const position = boardData.cards.filter(
                (c) => c.column_id === columnId
              ).length;

              const targetColumn = boardData.columns.find(
                (c) => c.id === columnId
              );
              const shouldLaunch =
                card != null &&
                card.session_id === null &&
                targetColumn?.role === 'in_progress';

              const moved = moveCard(cardId, columnId, position);
              if (shouldLaunch) {
                // Only attempted once `moveCard` has landed — the backend re-checks the
                // card's column role against the DB, so it'd still see the old column
                // (and skip) if this fired first.
                void moved
                  .then(() => launchOrAttachSession(cardId))
                  .then((outcome) =>
                    console.log(`launch_or_attach_session: ${outcome}`)
                  )
                  .catch((err) =>
                    console.error('Failed to launch/attach session:', err)
                  );
              } else {
                void moved;
              }
            }}
            onAddCard={(columnId, title) => {
              void createCard(boardData.board.id, columnId, title);
            }}
          />
        ))}

        <div className="w-[12.5rem] shrink-0">
          {isAddingColumn ? (
            <Input
              autoFocus
              value={newColumnName}
              placeholder="Column name…"
              onChange={(e) => setNewColumnName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newColumnName.trim()) {
                  void createColumn(boardData.board.id, newColumnName.trim());
                  setNewColumnName('');
                  setIsAddingColumn(false);
                }
                if (e.key === 'Escape') {
                  setNewColumnName('');
                  setIsAddingColumn(false);
                }
              }}
              onBlur={() => {
                setNewColumnName('');
                setIsAddingColumn(false);
              }}
              className="h-8 text-[13px]"
            />
          ) : (
            <button
              type="button"
              onClick={() => setIsAddingColumn(true)}
              className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] transition-colors"
            >
              <Plus className="size-3.5" />
              Add column
            </button>
          )}
        </div>
      </div>

      {selectedCard ? (
        <CardModal
          card={selectedCard}
          linkableSessions={linkableSessions}
          linkedSession={
            selectedCard.session_id
              ? (sessionsById.get(selectedCard.session_id) ?? null)
              : null
          }
          onClose={() => setSelectedCardId(null)}
          onSave={(title, description) => {
            void updateCard(selectedCard.id, title, description || undefined);
            setSelectedCardId(null);
          }}
          onDelete={() => {
            void deleteCard(selectedCard.id);
            setSelectedCardId(null);
          }}
          onLinkSession={(sessionId) => {
            void linkSessionToCard(selectedCard.id, sessionId);
          }}
        />
      ) : null}
    </div>
  );
}
