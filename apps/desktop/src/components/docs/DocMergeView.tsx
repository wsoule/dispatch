import type { ApiClient } from '@dispatch/client';
import type { FileContents, FileDiffOptions } from '@pierre/diffs';
import { MultiFileDiff } from '@pierre/diffs/react';
import { useMemo, useState } from 'react';

import { useDiffDisplaySettings } from '../../hooks/useDiffDisplaySettings';
import { useDocRevisions } from '../../hooks/useDocs';
import { toDiffRenderOptions } from '../../lib/diffDisplay';
import type { HunkChoice, MergePart } from '../../lib/mergeLayout';
import { labelFor, parseMarked, resolveMarked } from '../../lib/mergeLayout';
import { PierreWorkerPool } from '../runs/PierreWorkerPool';
import { ErrorBoundary } from '../shell/ErrorBoundary';
import { Button } from '@/ui/button';
import { Textarea } from '@/ui/textarea';

interface DocMergeViewProps {
  client: ApiClient;
  port: number | undefined;
  refId: string;
  /** The editor's text, marker lines and all. */
  text: string;
  /** The diff's file name, which also picks its highlighting. */
  name: string;
  onSave: (resolved: string) => void;
  onClose: () => void;
}

type Conflict = Extract<MergePart, { kind: 'conflict' }>;

// A cache key that changes with the text, so the diff pool never serves one
// block's render for another's (FNV-1a over UTF-16 code units).
function contentKey(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  }
  return `merge:${(h >>> 0).toString(16)}`;
}

interface HunkProps {
  conflict: Conflict;
  index: number;
  count: number;
  name: string;
  options: FileDiffOptions<undefined>;
  headLabel: string;
  mineLabel: string;
  choice: HunkChoice | null;
  onChoose: (choice: HunkChoice) => void;
}

// One conflict: its base, then head beside yours as a diff, resolved by
// Take head, Take yours or Edit.
function MergeHunk({
  conflict,
  index,
  count,
  name,
  options,
  headLabel,
  mineLabel,
  choice,
  onChoose,
}: HunkProps) {
  const head = conflict.head.join('');
  const mine = conflict.mine.join('');
  const base = conflict.base.join('');
  const oldFile = useMemo<FileContents>(
    () => ({ name, contents: head, cacheKey: contentKey(head) }),
    [name, head]
  );
  const newFile = useMemo<FileContents>(
    () => ({ name, contents: mine, cacheKey: contentKey(mine) }),
    [name, mine]
  );
  const take = choice?.take ?? null;
  const title = `Conflict ${index + 1} of ${count}`;
  return (
    <section
      aria-label={title}
      className="flex flex-col gap-2 border-b border-[var(--color-border)] p-3"
    >
      <header className="flex items-center gap-2 text-xs">
        <span className="font-medium">{title}</span>
        <div className="ml-auto flex gap-1">
          <Button
            size="xs"
            variant={take === 'head' ? 'default' : 'secondary'}
            aria-pressed={take === 'head'}
            onClick={() => onChoose({ take: 'head' })}
          >
            Take head
          </Button>
          <Button
            size="xs"
            variant={take === 'mine' ? 'default' : 'secondary'}
            aria-pressed={take === 'mine'}
            onClick={() => onChoose({ take: 'mine' })}
          >
            Take yours
          </Button>
          <Button
            size="xs"
            variant={take === 'edit' ? 'default' : 'secondary'}
            aria-pressed={take === 'edit'}
            onClick={() =>
              onChoose({
                take: 'edit',
                text: choice?.take === 'edit' ? choice.text : head + mine,
              })
            }
          >
            Edit
          </Button>
        </div>
      </header>
      {base !== '' && (
        <details className="text-xs">
          <summary className="cursor-pointer text-[var(--color-muted-foreground)]">
            Base
          </summary>
          <pre className="rounded-control mt-1 overflow-auto bg-[var(--color-muted)] p-2 font-mono text-[11px]">
            {base}
          </pre>
        </details>
      )}
      <div className="grid grid-cols-2 gap-2 text-[11px] text-[var(--color-muted-foreground)]">
        <span className="truncate">{`head · ${headLabel}`}</span>
        <span className="truncate">{`yours · ${mineLabel}`}</span>
      </div>
      <ErrorBoundary label={`the diff for ${title.toLowerCase()}`}>
        <MultiFileDiff oldFile={oldFile} newFile={newFile} options={options} />
      </ErrorBoundary>
      {choice?.take === 'edit' && (
        <Textarea
          aria-label={`Resolution for ${title.toLowerCase()}`}
          value={choice.text}
          onChange={(e) => onChoose({ take: 'edit', text: e.target.value })}
          className="font-mono text-xs"
        />
      )}
    </section>
  );
}

// The three-pane merge view: every marked block in the text, in either label
// style, each given a resolution, then saved as one text with no markers.
export function DocMergeView({
  client,
  port,
  refId,
  text,
  name,
  onSave,
  onClose,
}: DocMergeViewProps) {
  const { revisions } = useDocRevisions(client, port, refId);
  const [display] = useDiffDisplaySettings();
  const options = useMemo(
    () => ({
      ...toDiffRenderOptions(display),
      diffStyle: 'split' as const,
      disableFileHeader: true,
    }),
    [display]
  );
  const parts = useMemo(() => parseMarked(text), [text]);
  const conflicts = useMemo(
    () => parts.filter((p): p is Conflict => p.kind === 'conflict'),
    [parts]
  );
  // Choices belong to the text they were made on; new text starts over.
  const [picked, setPicked] = useState<{
    text: string;
    choices: (HunkChoice | null)[];
  }>({ text, choices: [] });
  const choices: (HunkChoice | null)[] = conflicts.map((_, i) =>
    picked.text === text ? (picked.choices[i] ?? null) : null
  );
  const choose = (i: number, choice: HunkChoice): void =>
    setPicked({ text, choices: choices.map((c, j) => (j === i ? choice : c)) });
  const done = choices.filter((c) => c !== null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2 text-xs">
        <span className="font-medium">Merge</span>
        <span className="text-[var(--color-muted-foreground)]">
          {conflicts.length === 0
            ? 'No marked blocks are left.'
            : `${done.length} of ${conflicts.length} resolved`}
        </span>
        <div className="ml-auto flex gap-1">
          <Button
            size="sm"
            disabled={conflicts.length === 0 || done.length < conflicts.length}
            onClick={() => onSave(resolveMarked(parts, done))}
          >
            Save resolution
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </header>
      <PierreWorkerPool lineDiffType={options.lineDiffType}>
        <div className="min-h-0 flex-1 overflow-auto">
          {conflicts.map((conflict, i) => (
            <MergeHunk
              // Choices are kept by position, so a block is its position too.
              key={i}
              conflict={conflict}
              index={i}
              count={conflicts.length}
              name={name}
              options={options}
              headLabel={labelFor(conflict.headLabel, revisions)}
              mineLabel={labelFor(conflict.mineLabel, revisions)}
              choice={choices[i]}
              onChoose={(choice) => choose(i, choice)}
            />
          ))}
        </div>
      </PierreWorkerPool>
    </div>
  );
}
