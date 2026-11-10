import type { Snippet } from '@dispatch/client';
import { Button, Chip, cx } from '@dispatch/ui';
import { useState } from 'react';

import { snippetLabel } from '../../lib/conversation';
import styles from './SnippetComposer.module.css';

/** A conversation target the composer can send to. `canAct` is the whole reason to pick one
 * target over another — whether the recipient can change the branch or only discuss it. */
export interface ChatTarget {
  id: string;
  label: string;
  canAct: boolean;
  hint?: string;
}

interface SnippetComposerProps {
  targets: ChatTarget[];
  attachments: Snippet[];
  onRemoveAttachment: (index: number) => void;
  onSend: (
    body: string,
    attachments: Snippet[],
    targetId: string
  ) => Promise<void>;
}

/**
 * Controlled chat composer for review conversations. It is deliberately target-agnostic: it
 * never fetches, never persists, and never learns what a target actually *is* — the caller owns
 * `targets`/`attachments` and receives the composed message via `onSend`. That keeps this file
 * renderable with no server, no run, and no Pierre.
 *
 * Not rebuilt on `PromptBar` despite otherwise being the closest fit in this codebase: it has
 * no slot for the target select, and `ReviewChatPanel.test.tsx` (plus
 * `PierreReviewDiff.test.tsx`) read the offered targets as `role="option"` straight after
 * mount. So this keeps its own textarea, target select and button, on PromptBar's frame: a
 * --surface box in a soft border that draws the field ring while anything in it has focus,
 * the attachments as removable library Chips.
 */
export function SnippetComposer({
  targets,
  attachments,
  onRemoveAttachment,
  onSend,
}: SnippetComposerProps) {
  const [body, setBody] = useState('');
  const [targetId, setTargetId] = useState(targets[0]?.id ?? '');
  const [sending, setSending] = useState(false);

  const selectedTarget = targets.find((t) => t.id === targetId) ?? targets[0];

  async function submit() {
    if (body.trim() === '' || sending || selectedTarget === undefined) return;
    setSending(true);
    try {
      await onSend(body.trim(), attachments, selectedTarget.id);
      setBody('');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={styles.box}>
      {attachments.length > 0 && (
        <ul className={styles.chips} aria-label="Attached code">
          {attachments.map((snippet, index) => {
            const label = snippetLabel(snippet);
            return (
              <li key={`${label}-${String(index)}`} className={styles.chipItem}>
                <Chip
                  removeLabel={`Remove ${label}`}
                  onRemove={() => onRemoveAttachment(index)}
                >
                  {/* A file path and a line range — a path keeps the code face. */}
                  <span className={styles.snippet}>{label}</span>
                </Chip>
              </li>
            );
          })}
        </ul>
      )}

      <textarea
        rows={3}
        placeholder="Ask about the selected code…"
        aria-label="Message"
        value={body}
        disabled={sending}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        className={cx('textarea', styles.textarea)}
      />

      <div className={styles.footer}>
        {/* A native select, not the library's Select (a PickerPopover that
            mounts its options only once opened): ReviewChatPanel.test and
            PierreReviewDiff.test read the offered targets as role="option"
            right after mount, which a real <select> keeps honest. PromptBar
            does the same for its model and effort choices. */}
        <select
          aria-label="Send to"
          value={selectedTarget?.id}
          disabled={sending}
          onChange={(e) => setTargetId(e.target.value)}
          className={cx('select', styles.select)}
        >
          {targets.map((target) => (
            <option key={target.id} value={target.id}>
              {target.label}
            </option>
          ))}
        </select>

        <Button
          variant="primary"
          size="sm"
          disabled={body.trim() === '' || sending}
          onClick={() => void submit()}
        >
          Send
        </Button>
      </div>

      {selectedTarget !== undefined && (
        <p className={styles.note}>
          {selectedTarget.canAct
            ? 'This target can edit this branch.'
            : "Read-only. It explains, it doesn't edit."}
        </p>
      )}
    </div>
  );
}
