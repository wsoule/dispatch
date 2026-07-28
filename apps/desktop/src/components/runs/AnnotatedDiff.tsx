import type { ReviewComment } from '@dispatch/client';
import { MessageSquarePlus } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';

import { ReviewComposer, ReviewThread } from './ReviewThread';
import type { DiffRow } from '@/lib/unifiedDiff';
import { foldContext, parseUnifiedDiff } from '@/lib/unifiedDiff';
import { cn } from '@/lib/utils';

interface AnnotatedDiffProps {
  patch: string;
  comments: ReviewComment[];
  onAdd: (input: {
    file: string;
    line: number;
    anchorText: string;
    body: string;
  }) => Promise<void>;
  onResolve: (commentId: string, resolved: boolean) => Promise<void>;
  onReply: (commentId: string, body: string) => Promise<void>;
  /** Restricts rendering to one file. Omit to show the whole patch. */
  only?: string;
}

const ROW_SKIN: Record<DiffRow['kind'], string> = {
  add: 'bg-state-review-surface',
  del: 'bg-state-failed-surface',
  context: '',
  hunk: 'bg-muted text-muted-foreground',
  meta: 'text-muted-foreground',
};

/**
 * The run's diff, rendered here rather than by `@pierre/diffs`, so a comment can sit under the
 * exact line it is about.
 *
 * That is the only reason this exists. The third-party renderer is perfectly good at showing a
 * patch but owns its own line markup and offers no per-line hook, so annotating meant either
 * overlaying absolutely-positioned boxes on top of it — which drift out of alignment the moment
 * anything re-renders — or parsing the patch and drawing the rows. This does the second.
 *
 * Threads render *between* rows rather than on top of them, so opening one pushes the diff down
 * instead of covering it, and line alignment survives by construction.
 */
export function AnnotatedDiff({
  patch,
  comments,
  onAdd,
  onResolve,
  onReply,
  only,
}: AnnotatedDiffProps) {
  const [composing, setComposing] = useState<{
    file: string;
    line: number;
    anchorText: string;
  } | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const files = useMemo(() => {
    const parsed = parseUnifiedDiff(patch);
    return only === undefined ? parsed : parsed.filter((f) => f.path === only);
  }, [patch, only]);

  // Comments indexed by file and new-side line, which is what a row can look itself up by.
  const byLine = useMemo(() => {
    const map = new Map<string, ReviewComment[]>();
    for (const c of comments) {
      const key = `${c.file}:${c.line}`;
      const bucket = map.get(key);
      if (bucket === undefined) map.set(key, [c]);
      else bucket.push(c);
    }
    return map;
  }, [comments]);

  async function guard(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  }

  if (files.length === 0) {
    return (
      <p className="text-muted-foreground p-4 text-[12.5px]">
        No changes to show.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {files.map((file) => {
        const rows = foldContext(file.rows);
        return (
          <section
            key={file.path}
            className="shadow-hairline overflow-hidden rounded-lg"
          >
            <div className="bg-muted flex items-center gap-2 px-3 py-1.5">
              <span className="dense-meta truncate">{file.path}</span>
              <span className="dense-meta text-state-review">
                +{file.additions}
              </span>
              <span className="dense-meta text-state-failed">
                −{file.deletions}
              </span>
            </div>

            <div className="overflow-x-auto font-mono text-[12px]">
              {rows.map((row, i) => {
                if (row.kind === 'fold') {
                  const key = `${file.path}:fold:${i}`;
                  const open = expanded.has(key);
                  return (
                    <Fragment key={key}>
                      <button
                        type="button"
                        onClick={() =>
                          setExpanded((prev) => {
                            const next = new Set(prev);
                            if (!next.delete(key)) next.add(key);
                            return next;
                          })
                        }
                        className="text-muted-foreground hover:bg-muted/60 hover:text-foreground bg-muted/30 w-full px-3 py-1 text-left text-[11px]"
                      >
                        {open
                          ? `Hide ${row.count} unchanged lines`
                          : `Show ${row.count} unchanged lines`}
                      </button>
                      {open &&
                        row.rows.map((hidden, j) => (
                          <Row
                            key={`${key}:${j}`}
                            row={hidden}
                            file={file.path}
                            comments={byLine}
                            busy={busy}
                            composing={composing}
                            setComposing={setComposing}
                            onAdd={(input) => void guard(() => onAdd(input))}
                            onResolve={(id, r) =>
                              void guard(() => onResolve(id, r))
                            }
                            onReply={(id, b) =>
                              void guard(() => onReply(id, b))
                            }
                          />
                        ))}
                    </Fragment>
                  );
                }
                return (
                  <Row
                    key={`${file.path}:${i}`}
                    row={row}
                    file={file.path}
                    comments={byLine}
                    busy={busy}
                    composing={composing}
                    setComposing={setComposing}
                    onAdd={(input) => void guard(() => onAdd(input))}
                    onResolve={(id, r) => void guard(() => onResolve(id, r))}
                    onReply={(id, b) => void guard(() => onReply(id, b))}
                  />
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function Row({
  row,
  file,
  comments,
  busy,
  composing,
  setComposing,
  onAdd,
  onResolve,
  onReply,
}: {
  row: DiffRow;
  file: string;
  comments: Map<string, ReviewComment[]>;
  busy: boolean;
  composing: { file: string; line: number; anchorText: string } | null;
  setComposing: (
    v: { file: string; line: number; anchorText: string } | null
  ) => void;
  onAdd: (input: {
    file: string;
    line: number;
    anchorText: string;
    body: string;
  }) => void;
  onResolve: (commentId: string, resolved: boolean) => void;
  onReply: (commentId: string, body: string) => void;
}) {
  // Only lines that exist on the new side can be commented on: a deleted line is not there for
  // the agent to go and change, so anchoring a note to it would point at nothing.
  const line = row.newLine;
  const threads = line === null ? [] : (comments.get(`${file}:${line}`) ?? []);
  const isComposing =
    composing !== null && composing.file === file && composing.line === line;

  return (
    <>
      <div
        className={cn(
          'group grid grid-cols-[44px_44px_20px_minmax(0,1fr)] items-start',
          ROW_SKIN[row.kind]
        )}
      >
        <span className="text-muted-foreground/60 px-1 text-right text-[11px] select-none">
          {row.oldLine ?? ''}
        </span>
        <span className="text-muted-foreground/60 px-1 text-right text-[11px] select-none">
          {row.newLine ?? ''}
        </span>
        <span className="flex justify-center">
          {line !== null && row.kind !== 'hunk' && row.kind !== 'meta' && (
            <button
              type="button"
              disabled={busy}
              aria-label={`Comment on line ${line}`}
              onClick={() => setComposing({ file, line, anchorText: row.text })}
              className="text-muted-foreground hover:text-accent-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100"
            >
              <MessageSquarePlus className="size-3" />
            </button>
          )}
        </span>
        <span className="pr-3 whitespace-pre-wrap">
          {row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}
          {row.text}
        </span>
      </div>

      {threads.map((c) => (
        <ReviewThread
          key={c.id}
          comment={c}
          // The thread is rendered on the row whose text still matches, so by construction it is
          // exact here — drift is reported by the panel view, which compares against the file.
          anchor="exact"
          onResolve={(resolved) => onResolve(c.id, resolved)}
          onReply={(body) => onReply(c.id, body)}
        />
      ))}

      {isComposing && line !== null && (
        <ReviewComposer
          line={line}
          onCancel={() => setComposing(null)}
          onSubmit={(body) => {
            onAdd({ file, line, anchorText: row.text, body });
            setComposing(null);
          }}
        />
      )}
    </>
  );
}
