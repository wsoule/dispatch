import { useEffect } from 'react';

import './Modal.css';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  /** Wider panel for content that doesn't fit the default 540px (e.g. a code diff). */
  wide?: boolean;
  children: React.ReactNode;
}

/**
 * Minimal, reusable modal: backdrop + centered panel. Clicking the backdrop or pressing
 * Escape closes it. Not hard-coded to any particular content — callers own what goes inside.
 */
export function Modal({ isOpen, onClose, title, wide, children }: ModalProps) {
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  return (
    // `data-modal="true"` marks every open `Modal` instance (CreateTaskModal,
    // SessionDetailModal, DiffModal, …) so `useGlobalKeyboard` can ask "is *any* modal open
    // right now" with a plain DOM query instead of every caller threading its own modal's
    // open state up to the app root. Deliberately not `role="dialog"` for this — the command
    // palette also uses that role (it genuinely is one), but the palette's own Escape closes
    // it *through* `navReducer`'s escape action rather than needing to be excluded from it,
    // so a selector that also matched the palette would wrongly suppress that.
    <div className="modal-backdrop" data-modal="true" onClick={onClose}>
      <div
        className={`modal-panel${wide ? ' modal-panel-wide' : ''}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          {title ? (
            <h2 className="modal-title" title={title}>
              {title}
            </h2>
          ) : (
            <span />
          )}
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
