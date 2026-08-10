import type { Snippet } from '@dispatch/client';
import { X } from 'lucide-react';
import { useState } from 'react';

import { snippetLabel } from '../../lib/conversation';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { Textarea } from '@/ui/textarea';

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
    <div className="flex flex-col gap-2">
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {attachments.map((snippet, index) => {
            const label = snippetLabel(snippet);
            return (
              <Badge
                key={`${label}-${index}`}
                variant="secondary"
                className="gap-1 pr-1 text-[11px]"
              >
                <span className="font-mono">{label}</span>
                <button
                  type="button"
                  aria-label={`Remove ${label}`}
                  className="hover:text-foreground text-muted-foreground"
                  onClick={() => onRemoveAttachment(index)}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            );
          })}
        </div>
      )}

      <Textarea
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
        className="resize-y text-[13px]"
      />

      <div className="flex items-center justify-between gap-3">
        {/* `NativeSelect`, not the Radix-backed `@/ui/select`: that primitive mounts its
            options only once opened (a `Presence`-gated portal), which breaks
            `ReviewChatPanel`'s coverage of which targets are offered — it reads
            `role="option"` right after mount, never opening the dropdown. A real `<select>`
            keeps that assertion honest while still landing on a shared primitive. */}
        <NativeSelect
          aria-label="Send to"
          size="sm"
          value={selectedTarget?.id}
          disabled={sending}
          onChange={(e) => setTargetId(e.target.value)}
          className="pl-2 text-[12px]"
        >
          {targets.map((target) => (
            <NativeSelectOption key={target.id} value={target.id}>
              {target.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>

        <Button
          type="button"
          size="sm"
          disabled={body.trim() === '' || sending}
          onClick={() => void submit()}
        >
          Send
        </Button>
      </div>

      {selectedTarget !== undefined && (
        <p className="text-muted-foreground text-[11px]">
          {selectedTarget.canAct
            ? 'This target can edit this branch.'
            : 'This target is read-only — it explains, it does not edit.'}
        </p>
      )}
    </div>
  );
}
