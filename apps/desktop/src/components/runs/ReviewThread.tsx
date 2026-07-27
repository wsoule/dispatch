import type { ReviewComment } from '@dispatch/client';
import { Check, CornerDownRight } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@/lib/utils';

interface ReviewThreadProps {
  comment: ReviewComment;
  /** How the anchor has fared since the comment was written. */
  anchor: 'exact' | 'moved' | 'outdated';
  onResolve: (resolved: boolean) => void;
  onReply: (body: string) => void;
}

/**
 * One comment thread, rendered beneath the line it was written against.
 *
 * The outdated marker is the part worth having. A comment whose code has changed underneath it
 * is still worth reading — the reviewer had a point — but presenting it as though it still
 * describes the current line would be a quiet lie. So it stays visible and says so.
 */
export function ReviewThread({
  comment,
  anchor,
  onResolve,
  onReply,
}: ReviewThreadProps) {
  const [reply, setReply] = useState('');

  return (
    <div
      className={cn(
        'bg-card shadow-hairline my-1.5 ml-[90px] rounded-lg p-3',
        comment.resolved && 'opacity-60'
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-accent-foreground text-[11px] font-medium">
          {comment.author}
        </span>
        {anchor === 'moved' && (
          <span className="dense-meta">moved to line {comment.line}</span>
        )}
        {anchor === 'outdated' && (
          <span className="dense-meta text-state-waiting">
            outdated — the code here changed
          </span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => onResolve(!comment.resolved)}
          className={cn(
            'text-[11px]',
            comment.resolved
              ? 'text-state-review'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {comment.resolved ? (
            <span className="inline-flex items-center gap-1">
              <Check className="size-3" />
              resolved
            </span>
          ) : (
            'resolve'
          )}
        </button>
      </div>

      <p className="mt-1.5 text-[12.5px] leading-relaxed">{comment.body}</p>

      {comment.replies.map((r) => (
        <div key={r.id} className="mt-2 flex gap-2">
          <CornerDownRight className="text-muted-foreground mt-0.5 size-3 shrink-0" />
          <div>
            <span className="text-accent-foreground text-[11px] font-medium">
              {r.author}
            </span>
            <p className="text-[12.5px] leading-relaxed">{r.body}</p>
          </div>
        </div>
      ))}

      {!comment.resolved && (
        <div className="mt-2 flex gap-2">
          <input
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && reply.trim() !== '') {
                onReply(reply.trim());
                setReply('');
              }
            }}
            placeholder="Reply — the agent reads this when you send the work back"
            className="shadow-hairline min-w-0 flex-1 rounded-md px-2 py-1 text-[12px] outline-none"
          />
        </div>
      )}
    </div>
  );
}

interface ComposerProps {
  line: number;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}

/** The inline "comment on line N" box, anchored beneath the line it targets. */
export function ReviewComposer({ line, onSubmit, onCancel }: ComposerProps) {
  const [body, setBody] = useState('');
  return (
    <div className="bg-card shadow-hairline-strong my-1.5 ml-[90px] rounded-lg p-3">
      <div className="dense-label text-accent-foreground">
        Comment on line {line}
      </div>
      <textarea
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim()) {
            onSubmit(body.trim());
          }
        }}
        placeholder="What should change? This goes back with the work."
        className="mt-1.5 min-h-[52px] w-full resize-y bg-transparent text-[12.5px] outline-none"
      />
      <div className="mt-1.5 flex gap-2">
        <button
          type="button"
          disabled={body.trim() === ''}
          onClick={() => onSubmit(body.trim())}
          className="bg-accent text-accent-foreground rounded-md px-2.5 py-1 text-[12px] disabled:opacity-50"
        >
          Add comment
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="shadow-hairline rounded-md px-2.5 py-1 text-[12px]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
