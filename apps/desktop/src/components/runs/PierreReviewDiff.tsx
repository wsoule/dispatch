import type { ReviewComment } from '@dispatch/client';
import type { CodeViewDiffItem, DiffLineAnnotation } from '@pierre/diffs';
import { processPatch } from '@pierre/diffs';
import { CodeView } from '@pierre/diffs/react';
import { MessageSquarePlus } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { ErrorBoundary } from '../shell/ErrorBoundary';
import { PierreWorkerPool } from './PierreWorkerPool';
import { ReviewComposer, ReviewThread } from './ReviewThread';

/** What each annotation carries, so `renderAnnotation` knows what to draw. */
type Annotation =
  | { kind: 'threads'; file: string; comments: ReviewComment[] }
  | { kind: 'composer'; file: string; anchorText: string };

interface PierreReviewDiffProps {
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
  /** Files the reviewer has ticked off — rendered collapsed, the way GitHub does. */
  viewed?: ReadonlySet<string>;
  /** Restricts rendering to one file. Omit for the whole patch in one scroller. */
  only?: string;
}

/**
 * The review diff: Pierre's `CodeView` with comment threads injected as line annotations.
 *
 * An earlier version of this parsed the patch by hand and drew its own rows, on the belief that
 * Pierre exposed no per-line hook. That was simply wrong — `CodeView` takes `annotations` per
 * file/side/line and hands them back through `renderAnnotation`, which is exactly the mechanism
 * GitHub-style inline threads need. Using it means the diff keeps syntax highlighting,
 * virtualisation, hunk expansion and the worker pool, none of which a hand-rolled renderer had.
 *
 * `renderGutterUtility` supplies the hover affordance on each line, so starting a comment is the
 * same gesture as on GitHub: hover the line, click the +.
 */
export function PierreReviewDiff({
  patch,
  comments,
  onAdd,
  onResolve,
  onReply,
  viewed,
  only,
}: PierreReviewDiffProps) {
  // Where a composer is currently open, keyed the same way annotations are.
  const [composing, setComposing] = useState<{
    file: string;
    line: number;
    anchorText: string;
  } | null>(null);

  const files = useMemo(() => {
    try {
      const parsed = processPatch(patch, 'review');
      return only === undefined
        ? parsed.files
        : parsed.files.filter((f) => f.name === only);
    } catch {
      // A patch Pierre cannot parse should cost the diff, not the whole review surface — the
      // comment panel beside it still works.
      return [];
    }
  }, [patch, only]);

  const items = useMemo<CodeViewDiffItem<Annotation>[]>(() => {
    return files.map((fileDiff) => {
      const annotations: DiffLineAnnotation<Annotation>[] = [];

      // Existing threads, grouped so several comments on one line render as one stack rather
      // than several separately-positioned annotations fighting for the same row.
      const byLine = new Map<number, ReviewComment[]>();
      for (const c of comments) {
        if (c.file !== fileDiff.name) continue;
        const bucket = byLine.get(c.line);
        if (bucket === undefined) byLine.set(c.line, [c]);
        else bucket.push(c);
      }
      for (const [line, list] of byLine) {
        annotations.push({
          side: 'additions',
          lineNumber: line,
          metadata: { kind: 'threads', file: fileDiff.name, comments: list },
        });
      }

      if (composing !== null && composing.file === fileDiff.name) {
        annotations.push({
          side: 'additions',
          lineNumber: composing.line,
          metadata: {
            kind: 'composer',
            file: composing.file,
            anchorText: composing.anchorText,
          },
        });
      }

      return {
        id: fileDiff.name,
        type: 'diff',
        fileDiff,
        annotations,
        // A file you have ticked off collapses, so a long review visibly shrinks as you work
        // through it rather than staying the same size forever.
        collapsed: viewed?.has(fileDiff.name) ?? false,
      };
    });
  }, [files, comments, composing, viewed]);

  const renderAnnotation = useCallback(
    (annotation: { metadata?: Annotation }) => {
      const meta = annotation.metadata;
      if (meta === undefined) return null;
      if (meta.kind === 'composer') {
        return (
          <ReviewComposer
            line={composing?.line ?? 0}
            onCancel={() => setComposing(null)}
            onSubmit={(body) => {
              void onAdd({
                file: meta.file,
                line: composing?.line ?? 0,
                anchorText: meta.anchorText,
                body,
              });
              setComposing(null);
            }}
          />
        );
      }
      return (
        <div className="flex flex-col">
          {meta.comments.map((c) => (
            <ReviewThread
              key={c.id}
              comment={c}
              // Rendered against the line Pierre placed it on, so within this view it is by
              // definition where it belongs; drift against the working tree is reported by the
              // store's own anchor check.
              anchor="exact"
              onResolve={(resolved) => void onResolve(c.id, resolved)}
              onReply={(body) => void onReply(c.id, body)}
            />
          ))}
        </div>
      );
    },
    [composing, onAdd, onResolve, onReply]
  );

  const renderGutterUtility = useCallback(
    (
      getHoveredLine: () => { lineNumber?: number; side?: string } | undefined,
      item: { id: string }
    ) => (
      <button
        type="button"
        aria-label="Comment on this line"
        onClick={() => {
          const hovered = getHoveredLine();
          const line = hovered?.lineNumber;
          // Only the additions side can be commented on: a deleted line is not there for the
          // agent to change, so a note anchored to it would point at nothing.
          if (line === undefined || hovered?.side === 'deletions') return;
          setComposing({ file: item.id, line, anchorText: '' });
        }}
        className="text-muted-foreground hover:text-accent-foreground grid size-4 place-items-center"
      >
        <MessageSquarePlus className="size-3" />
      </button>
    ),
    []
  );

  if (files.length === 0) {
    return (
      <p className="text-muted-foreground p-4 text-[12.5px]">
        No changes to show.
      </p>
    );
  }

  return (
    <ErrorBoundary>
      <PierreWorkerPool>
        <CodeView<Annotation>
          items={items}
          renderAnnotation={renderAnnotation}
          renderGutterUtility={renderGutterUtility}
          className="size-full"
        />
      </PierreWorkerPool>
    </ErrorBoundary>
  );
}
