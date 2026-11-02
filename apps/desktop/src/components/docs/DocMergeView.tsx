import type { ApiClient } from '@dispatch/client';
import { Button, cx, Disclosure, TextArea } from '@dispatch/ui';
import type { FileContents, FileDiffOptions } from '@pierre/diffs';
import { MultiFileDiff } from '@pierre/diffs/react';
import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

import { useDiffDisplaySettings } from '../../hooks/useDiffDisplaySettings';
import { useDocRevisions } from '../../hooks/useDocs';
import { toDiffRenderOptions } from '../../lib/diffDisplay';
import type { HunkChoice, MergePart } from '../../lib/mergeLayout';
import { labelFor, parseMarked, resolveMarked } from '../../lib/mergeLayout';
import { PierreWorkerPool } from '../runs/PierreWorkerPool';
import { ErrorBoundary } from '../shell/ErrorBoundary';
import styles from './DocMergeView.module.css';

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

// One side pick of a conflict (Take head, Take yours, Edit): a bordered
// toggle whose chosen state leads with a check as well as the pressed fill,
// so the side taken never rests on a faint fill alone (the fill is about
// 1.2:1 on the surface; the check is drawn in the text's ink).
function PickButton({
  chosen,
  onClick,
  children,
}: {
  chosen: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      size="sm"
      variant="secondary"
      aria-pressed={chosen}
      icon={chosen ? <Check size={14} strokeWidth={1.8} /> : undefined}
      onClick={onClick}
    >
      {children}
    </Button>
  );
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
    <section aria-label={title} className={styles.hunk}>
      <header className={styles.hunkHead}>
        <span className={styles.hunkTitle}>{title}</span>
        <div className={styles.picks}>
          <PickButton
            chosen={take === 'head'}
            onClick={() => onChoose({ take: 'head' })}
          >
            Take head
          </PickButton>
          <PickButton
            chosen={take === 'mine'}
            onClick={() => onChoose({ take: 'mine' })}
          >
            Take yours
          </PickButton>
          <PickButton
            chosen={take === 'edit'}
            onClick={() =>
              onChoose({
                take: 'edit',
                text: choice?.take === 'edit' ? choice.text : head + mine,
              })
            }
          >
            Edit
          </PickButton>
        </div>
      </header>
      {base !== '' && (
        <Disclosure summary="Base">
          <pre className={cx('mono', styles.base)}>{base}</pre>
        </Disclosure>
      )}
      <div className={styles.sides}>
        <span className={styles.side}>{`head · ${headLabel}`}</span>
        <span className={styles.side}>{`yours · ${mineLabel}`}</span>
      </div>
      <ErrorBoundary label={`the diff for ${title.toLowerCase()}`}>
        <MultiFileDiff oldFile={oldFile} newFile={newFile} options={options} />
      </ErrorBoundary>
      {choice?.take === 'edit' && (
        <TextArea
          aria-label={`Resolution for ${title.toLowerCase()}`}
          value={choice.text}
          onChange={(e) => onChoose({ take: 'edit', text: e.target.value })}
          className={styles.resolution}
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
    <div className={styles.merge}>
      <header className={styles.head}>
        <span className={styles.headTitle}>Merge</span>
        <span className={cx('num', styles.progress)}>
          {conflicts.length === 0
            ? 'No marked blocks are left.'
            : `${done.length} of ${conflicts.length} resolved`}
        </span>
        <div className={styles.actions}>
          <Button
            size="sm"
            variant="primary"
            disabled={conflicts.length === 0 || done.length < conflicts.length}
            onClick={() => onSave(resolveMarked(parts, done))}
          >
            Save resolution
          </Button>
          <Button size="sm" variant="quiet" onClick={onClose}>
            Close
          </Button>
        </div>
      </header>
      <PierreWorkerPool lineDiffType={options.lineDiffType}>
        <div className={styles.hunks}>
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
