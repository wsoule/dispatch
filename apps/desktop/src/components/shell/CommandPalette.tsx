import { useEffect, useMemo, useRef, useState } from 'react';

import type { PaletteItem } from '../../lib/paletteMatch';
import { rankPaletteItems } from '../../lib/paletteMatch';
import './CommandPalette.css';

export interface PaletteEntry extends PaletteItem {
  /** A short tag shown at the entry's right edge — "task", "go to", "action" — so the fuzzy
   * list stays scannable once tasks and view-switch actions are mixed together. */
  kind: string;
  run: () => void;
}

interface CommandPaletteProps {
  isOpen: boolean;
  entries: PaletteEntry[];
  onClose: () => void;
}

/**
 * The Linear-signature ⌘K palette: fuzzy-matches task ids/titles and app actions ("Dispatch
 * <task>", "New task", every view switch) against a single query. Arrow keys (not j/k — the
 * input itself is a text field, and "j"/"k" are real letters someone might type into a
 * search box) move the highlighted row; Enter runs it; Escape closes via the caller's
 * `onClose` (also wired through the app-level `navReducer`'s `escape` action).
 */
export function CommandPalette({
  isOpen,
  entries,
  onClose,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const ranked = useMemo(
    () => rankPaletteItems(entries, query),
    [entries, query]
  );

  // Reset to a clean search every time the palette opens, and focus the input immediately —
  // a command palette that doesn't grab focus on open isn't usable from the keyboard at all.
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setHighlighted(0);
      inputRef.current?.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    setHighlighted(0);
  }, [query]);

  if (!isOpen) return null;

  function runHighlighted() {
    const entry = ranked[highlighted];
    if (entry !== undefined) {
      entry.run();
      onClose();
    }
  }

  return (
    <div className="command-palette-backdrop" onClick={onClose}>
      <div
        className="command-palette-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Command palette"
      >
        <input
          ref={inputRef}
          className="command-palette-input"
          placeholder="Jump to a task, dispatch work, or switch views…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setHighlighted((h) => Math.min(h + 1, ranked.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHighlighted((h) => Math.max(h - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              runHighlighted();
            }
          }}
        />
        <div className="command-palette-results">
          {ranked.length === 0 && (
            <div className="command-palette-empty">No matches.</div>
          )}
          {ranked.map((entry, i) => (
            <button
              key={entry.id}
              type="button"
              className={`command-palette-item${
                i === highlighted ? ' active' : ''
              }`}
              onMouseEnter={() => setHighlighted(i)}
              onClick={() => {
                entry.run();
                onClose();
              }}
            >
              <span className="command-palette-item-label">{entry.label}</span>
              {entry.sublabel !== undefined && (
                <span className="command-palette-item-sublabel">
                  {entry.sublabel}
                </span>
              )}
              <span className="command-palette-item-kind">{entry.kind}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
