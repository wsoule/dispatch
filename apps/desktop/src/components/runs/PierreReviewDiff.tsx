import type { Finding, ReviewComment } from '@dispatch/client';
import type { CodeViewDiffItem, DiffLineAnnotation } from '@pierre/diffs';
import { processPatch } from '@pierre/diffs';
import type { CodeViewHandle } from '@pierre/diffs/react';
import { CodeView } from '@pierre/diffs/react';
import { MessageSquarePlus, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ErrorBoundary } from '../shell/ErrorBoundary';
import { PierreWorkerPool } from './PierreWorkerPool';
import { ReviewComposer, ReviewThread } from './ReviewThread';
import { useDiffDisplaySettings } from '@/hooks/useDiffDisplaySettings';
import { toDiffRenderOptions } from '@/lib/diffDisplay';

/** What each annotation carries, so `renderAnnotation` knows what to draw. */
type Annotation =
  | { kind: 'threads'; file: string; comments: ReviewComment[] }
  | { kind: 'findings'; file: string; findings: Finding[] }
  | {
      kind: 'composer';
      file: string;
      anchorText: string;
      startLine?: number;
    };

interface PierreReviewDiffProps {
  patch: string;
  comments: ReviewComment[];
  /**
   * Where a new line comment goes. Omit it when there is nowhere to put one
   * (a GitHub PR) and the gutter's "+" is withheld rather than left dead.
   */
  onAdd?: (input: {
    file: string;
    line: number;
    startLine?: number;
    anchorText: string;
    body: string;
  }) => Promise<void>;
  onResolve: (commentId: string, resolved: boolean) => Promise<void>;
  onReply: (commentId: string, body: string) => Promise<void>;
  /** Files the reviewer has ticked off — rendered collapsed, the way GitHub does. */
  viewed?: ReadonlySet<string>;
  /** Restricts rendering to one file. Omit for the whole patch in one scroller. */
  only?: string;
  /** Open agent-review findings, rendered on their own lines beside the reviewer's threads. */
  findings?: Finding[];
  /**
   * A comment to scroll to. Changing this scrolls the diff; the caller bumps it (rather than
   * calling a method) so the jump is declarative and survives the view remounting.
   */
  scrollTo?: { file: string; line: number; nonce: number } | null;
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
  findings,
  scrollTo,
}: PierreReviewDiffProps) {
  // Where a composer is currently open, keyed the same way annotations are.
  const [composing, setComposing] = useState<{
    file: string;
    line: number;
    /** Set when the reviewer had a range selected — the comment covers startLine..line. */
    startLine?: number;
    anchorText: string;
  } | null>(null);
  // The live line selection. Pierre owns the drag; this only reads it, so that clicking the
  // gutter + on a selected range comments on the whole range rather than the one line hovered.
  const [selection, setSelection] = useState<{
    start: number;
    end: number;
    side?: string;
  } | null>(null);
  const viewRef = useRef<CodeViewHandle<Annotation> | null>(null);
  const [diffDisplay] = useDiffDisplaySettings();
  const diffOptions = useMemo(
    () => toDiffRenderOptions(diffDisplay),
    [diffDisplay]
  );

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

      // The agent review's findings, anchored the same way threads are. A finding with no line
      // has nothing to point at here and belongs to the case panel instead.
      const findingsByLine = new Map<number, Finding[]>();
      for (const f of findings ?? []) {
        if (f.file !== fileDiff.name || f.line === null) continue;
        const bucket = findingsByLine.get(f.line);
        if (bucket === undefined) findingsByLine.set(f.line, [f]);
        else bucket.push(f);
      }
      for (const [line, list] of findingsByLine) {
        annotations.push({
          side: 'additions',
          lineNumber: line,
          metadata: { kind: 'findings', file: fileDiff.name, findings: list },
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
            ...(composing.startLine !== undefined
              ? { startLine: composing.startLine }
              : {}),
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
  }, [files, comments, findings, composing, viewed]);

  const renderAnnotation = useCallback(
    (annotation: { metadata?: Annotation }) => {
      const meta = annotation.metadata;
      if (meta === undefined) return null;
      if (meta.kind === 'composer') {
        return (
          <ReviewComposer
            line={composing?.line ?? 0}
            startLine={meta.startLine}
            onCancel={() => setComposing(null)}
            onSubmit={(body) => {
              void onAdd?.({
                file: meta.file,
                line: composing?.line ?? 0,
                startLine: meta.startLine,
                anchorText: meta.anchorText,
                body,
              });
              setComposing(null);
            }}
          />
        );
      }
      if (meta.kind === 'findings') {
        return (
          <div className="flex flex-col gap-1 py-1">
            {meta.findings.map((f) => (
              <div
                key={f.id}
                className="border-state-waiting/40 bg-state-waiting/5 rounded-md border-l-2 px-2 py-1"
              >
                <div className="flex items-center gap-1.5 text-[12px]">
                  <TriangleAlert className="text-state-waiting size-3 shrink-0" />
                  {/* Marked as the agent's claim rather than the reviewer's note: the two sit on
                      the same line and must not be mistaken for each other. */}
                  <span className="dense-meta shrink-0">
                    agent · {f.severity}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{f.title}</span>
                </div>
                <p className="text-muted-foreground text-[11px] leading-snug">
                  {f.detail}
                </p>
              </div>
            ))}
          </div>
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
          // If the reviewer dragged a range that contains this line, comment on the whole
          // range — that is what the selection was for. Otherwise it is a single line.
          const inRange =
            selection !== null &&
            selection.side !== 'deletions' &&
            line >= Math.min(selection.start, selection.end) &&
            line <= Math.max(selection.start, selection.end);
          setComposing({
            file: item.id,
            line: inRange ? Math.max(selection.start, selection.end) : line,
            ...(inRange
              ? { startLine: Math.min(selection.start, selection.end) }
              : {}),
            anchorText: '',
          });
        }}
        className="text-muted-foreground hover:text-accent-foreground grid size-4 place-items-center"
      >
        <MessageSquarePlus className="size-3" />
      </button>
    ),
    [selection]
  );

  // Declarative jump: the effect fires when `scrollTo` changes identity, so clicking the same
  // thread twice still scrolls (the caller bumps `nonce`).
  useEffect(() => {
    if (scrollTo == null) return;
    viewRef.current?.scrollTo({
      type: 'line',
      id: scrollTo.file,
      lineNumber: scrollTo.line,
      side: 'additions',
      align: 'center',
    });
  }, [scrollTo]);

  if (files.length === 0) {
    return (
      <p className="text-muted-foreground p-4 text-[12.5px]">
        No changes to show.
      </p>
    );
  }

  return (
    <ErrorBoundary>
      <PierreWorkerPool lineDiffType={diffOptions.lineDiffType}>
        <CodeView<Annotation>
          ref={viewRef}
          items={items}
          options={diffOptions}
          onSelectedLinesChange={(sel) =>
            setSelection(
              sel === null
                ? null
                : {
                    start: sel.range.start,
                    end: sel.range.end,
                    side: sel.range.side,
                  }
            )
          }
          renderAnnotation={renderAnnotation}
          // No `onAdd` means no destination for a comment, so the hover "+"
          // that starts one is not offered at all.
          renderGutterUtility={
            onAdd === undefined ? undefined : renderGutterUtility
          }
          // `CodeView` attaches its own scroll listener to this exact element and reads its
          // own `scrollTop` to decide which virtualized rows to render — an ancestor owning
          // the `overflow-auto` instead leaves this element's `scrollTop` permanently 0, so
          // the window of rendered rows never advances past the first screenful. This element
          // must be the actual scroll container.
          //
          // `flex-1` rather than `size-full`/`h-full`: the caller (`ReviewView`) makes this
          // element's parent a flex column, so this sizes directly off that container's own
          // resolved height. A percentage height here would instead have to resolve through
          // that flex column's own height, which itself was only ever a stretch-resolved grid
          // cell — a chain some engines collapse to zero rather than a real pixel value, which
          // reads as this pane rendering only its (non-virtualized) file header and nothing
          // else. `flex-1` sizes off the immediate container directly, with no such chain.
          className="min-h-0 w-full flex-1 overflow-auto"
        />
      </PierreWorkerPool>
    </ErrorBoundary>
  );
}
