import type { DiffResult, ReviewComment } from '@dispatch/client';
import { MessageSquarePlus } from 'lucide-react';
import { useMemo, useState } from 'react';

import { SectionLabel } from '../ui/SectionLabel';
import { ReviewComposer, ReviewThread } from './ReviewThread';
import { cn } from '@/lib/utils';

interface ReviewCommentsPanelProps {
  comments: ReviewComment[];
  diff: DiffResult | undefined;
  onAdd: (input: {
    file: string;
    line: number;
    anchorText: string;
    body: string;
  }) => Promise<void>;
  onResolve: (commentId: string, resolved: boolean) => Promise<void>;
  onReply: (commentId: string, body: string) => Promise<void>;
  onSendBack: (note: string) => Promise<void>;
}

/**
 * Review comments for a run, beside its diff.
 *
 * The mockup drew these inline, anchored under the exact diff line. The diff itself is rendered
 * by `@pierre/diffs`'s `FileDiff`, which owns its own line markup and exposes no per-line hook —
 * so inline threads would mean forking or overlaying a third-party renderer, and an overlay that
 * drifts out of alignment on a re-render is worse than no inline at all. The threads live in a
 * panel instead: the same capability (comment on a line, reply, resolve, send it all back), one
 * pane over rather than one line down.
 *
 * Comments still carry a real line anchor, so if the inline route opens up later — a fork, or an
 * upstream hook — nothing about the stored data has to change.
 */
export function ReviewCommentsPanel({
  comments,
  diff,
  onAdd,
  onResolve,
  onReply,
  onSendBack,
}: ReviewCommentsPanelProps) {
  const [composing, setComposing] = useState(false);
  const [file, setFile] = useState('');
  const [line, setLine] = useState('1');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const files = useMemo(() => diff?.files.map((f) => f.path) ?? [], [diff]);
  const open = comments.filter((c) => !c.resolved);
  const byFile = useMemo(() => {
    const map = new Map<string, ReviewComment[]>();
    for (const c of comments) {
      const bucket = map.get(c.file);
      if (bucket === undefined) map.set(c.file, [c]);
      else bucket.push(c);
    }
    for (const list of map.values()) list.sort((a, b) => a.line - b.line);
    return map;
  }, [comments]);

  async function guard(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionLabel
        rule
        count={comments.length}
        trailing={
          <button
            type="button"
            onClick={() => {
              setComposing(true);
              if (file === '') setFile(files[0] ?? '');
            }}
            disabled={files.length === 0}
            className="text-accent-foreground inline-flex items-center gap-1 text-[11px] disabled:opacity-40"
          >
            <MessageSquarePlus className="size-3" />
            Comment on a line
          </button>
        }
      >
        Review comments
      </SectionLabel>

      {error !== null && (
        <p className="text-state-failed text-[12px]">{error}</p>
      )}

      {composing && (
        <div className="shadow-hairline rounded-lg p-3">
          <div className="flex gap-2">
            <select
              value={file}
              onChange={(e) => setFile(e.target.value)}
              className="shadow-hairline min-w-0 flex-1 rounded-md px-2 py-1 text-[12px]"
            >
              {files.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <input
              value={line}
              onChange={(e) => setLine(e.target.value)}
              inputMode="numeric"
              aria-label="Line number"
              className="shadow-hairline w-16 rounded-md px-2 py-1 text-[12px]"
            />
          </div>
          <ReviewComposer
            line={Number(line) || 1}
            onCancel={() => setComposing(false)}
            onSubmit={(body) =>
              void guard(async () => {
                await onAdd({
                  file,
                  line: Number(line) || 1,
                  // The panel cannot read the line's text out of the third-party diff renderer,
                  // so the anchor is left empty here. resolveAnchor treats an empty anchor as
                  // never-followable, which means such a comment simply never claims to have
                  // moved — it stays on the line it was filed against.
                  anchorText: '',
                  body,
                });
                setComposing(false);
              })
            }
          />
        </div>
      )}

      {comments.length === 0 ? (
        <p className="text-muted-foreground text-[12.5px]">
          No comments yet. Anything you leave here goes back to the agent with
          the work.
        </p>
      ) : (
        [...byFile.entries()].map(([path, list]) => (
          <div key={path}>
            <div className="dense-meta mb-1 truncate">{path}</div>
            {list.map((c) => (
              <ReviewThread
                key={c.id}
                comment={c}
                // The panel has no file contents to compare against, so it never claims a
                // comment has moved or gone stale — only the diff-side renderer could know.
                anchor="exact"
                onResolve={(resolved) =>
                  void guard(() => onResolve(c.id, resolved))
                }
                onReply={(body) => void guard(() => onReply(c.id, body))}
              />
            ))}
          </div>
        ))
      )}

      <div className="shadow-hairline rounded-lg p-3">
        <SectionLabel>Send it back</SectionLabel>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Anything the agent should know before it tries again…"
          className="mt-2 min-h-[64px] w-full resize-y bg-transparent text-[12.5px] outline-none"
        />
        <div className="mt-2 flex items-center gap-2">
          <span className="dense-meta flex-1">
            {open.length === 0
              ? 'No open threads — the note goes on its own.'
              : `${open.length} open ${open.length === 1 ? 'thread travels' : 'threads travel'} with it.`}
          </span>
          <button
            type="button"
            disabled={busy || (note.trim() === '' && open.length === 0)}
            onClick={() =>
              void guard(async () => {
                await onSendBack(note.trim());
                setNote('');
              })
            }
            className={cn(
              'bg-accent text-accent-foreground rounded-md px-2.5 py-1 text-[12px]',
              'disabled:opacity-50'
            )}
          >
            Send back with notes
          </button>
        </div>
      </div>
    </div>
  );
}
