import { useState } from 'react';

import { agentMeta } from '../../lib/agents';
import type { Card, Session } from '../../lib/types';
import { Modal } from '../ui/Modal';
import './CardModal.css';

interface CardModalProps {
  card: Card;
  /** Sessions belonging to this card's project that no other card is linked to yet — the
   * candidate list for "link to session." Empty once every session on the project is spoken
   * for. */
  linkableSessions: Session[];
  linkedSession: Session | null;
  onClose: () => void;
  onSave: (title: string, description: string) => void;
  onDelete: () => void;
  onLinkSession: (sessionId: string) => void;
}

export function CardModal({
  card,
  linkableSessions,
  linkedSession,
  onClose,
  onSave,
  onDelete,
  onLinkSession,
}: CardModalProps) {
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description ?? '');

  const dirty =
    title !== card.title || description !== (card.description ?? '');

  return (
    <Modal isOpen onClose={onClose} title="Card">
      <div className="card-modal">
        <input
          className="card-modal-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Card title"
        />
        <textarea
          className="card-modal-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          rows={4}
        />

        {linkedSession ? (
          <div className="card-modal-session">
            <span className="card-modal-session-label">Linked session</span>
            <span className="card-modal-session-value">
              {agentMeta(linkedSession.agent).icon}{' '}
              {linkedSession.model ?? agentMeta(linkedSession.agent).label} ·{' '}
              {linkedSession.status}
              {linkedSession.summary ? ` — ${linkedSession.summary}` : ''}
            </span>
          </div>
        ) : linkableSessions.length > 0 ? (
          <div className="card-modal-session">
            <span className="card-modal-session-label">Link to session</span>
            <select
              defaultValue=""
              onChange={(e) => e.target.value && onLinkSession(e.target.value)}
            >
              <option value="" disabled>
                Choose a session…
              </option>
              {linkableSessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {agentMeta(s.agent).icon}{' '}
                  {s.model ?? agentMeta(s.agent).label} · {s.status} ·{' '}
                  {new Date((s.started_at ?? 0) * 1000).toLocaleString()}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="card-modal-actions">
          <button className="card-modal-delete" onClick={onDelete}>
            Delete
          </button>
          <button
            className="card-modal-save"
            disabled={!dirty || title.trim() === ''}
            onClick={() => onSave(title.trim(), description.trim())}
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
