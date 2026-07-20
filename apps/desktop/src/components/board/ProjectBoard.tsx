import { useQuery } from '@tanstack/react-query';
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
import './ProjectBoard.css';

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
    return <p className="project-board-status">Loading board…</p>;
  }

  return (
    <div className="project-board">
      <div className="project-board-columns">
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

        <div className="project-board-add-column">
          {isAddingColumn ? (
            <input
              className="board-column-add-input"
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
            />
          ) : (
            <button
              className="board-column-add-button"
              onClick={() => setIsAddingColumn(true)}
            >
              + Add column
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
