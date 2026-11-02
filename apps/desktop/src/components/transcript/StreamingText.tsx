import { Button } from '@dispatch/ui';
import { CornerDownLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { memo, useMemo } from 'react';

import { useStreamedText } from '../../hooks/useStreamedText';
import styles from './transcript.module.css';

type StreamingTextSource = {
  id: string;
  label: string;
  href?: string;
};

type StreamingTextProps = {
  text: string;
  streaming: boolean;
  /** Draws the revealed text, e.g. through the app's Markdown component, so formatting
   * shows while the text streams instead of popping in at the end. It gets the text with
   * an unterminated code fence closed (see `closeOpenFence`), and owns the typography:
   * nothing is added around it, so a streamed row can look exactly like the settled row
   * that replaces it. No caret is drawn, since a rendered block has no inline end to put
   * one on. Without it the text is a plain paragraph with a typing caret. */
  render?: (text: string) => ReactNode;
  /** With `render`, for a text that keeps growing (a CLI agent's whole output): each
   * finished Markdown block (see `splitSettledMarkdown`) is drawn once through `render`,
   * and only the open one is revealed, so a change redraws one block rather than the whole
   * text. Pass a `render` that stays the same function, or every block is drawn again.
   * The blocks are siblings in one column, with nothing between them, under
   * `data-slot="streaming-blocks"` for the caller's stylesheet to space. */
  blocks?: boolean;
  sources?: StreamingTextSource[];
  followUps?: string[];
  onFollowUp?: (followUp: string) => void;
  actions?: ReactNode;
};

// One numbered citation chip. Renders as a link when the source has a URL (opened in a
// new tab), otherwise a plain button so the row still reads as interactive and stays
// keyboard-focusable.
function SourceChip({
  index,
  source,
}: {
  index: number;
  source: StreamingTextSource;
}) {
  const content = (
    <>
      <sup className={styles.sourceIndex}>{index + 1}</sup>
      {source.label}
    </>
  );

  return source.href ? (
    <a
      href={source.href}
      target="_blank"
      rel="noreferrer"
      className={styles.source}
    >
      {content}
    </a>
  ) : (
    <button type="button" className={styles.source}>
      {content}
    </button>
  );
}

// A line that opens or closes a fenced code block: up to three spaces, then three or more
// backticks or tildes, then (for an opener) an info string.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

// The code fence open after `line`, given the one open before it (null outside a code
// block): a fence line outside one opens one, and a long enough fence of the same kind
// with nothing after it closes it.
function fenceAfter(open: string | null, line: string): string | null {
  const match = FENCE.exec(line);
  if (match === null) return open;
  const [, fence, rest] = match;
  if (open === null) {
    // A backtick fence's info string may not hold a backtick (CommonMark).
    return fence[0] !== '`' || !rest.includes('`') ? fence : null;
  }
  return fence[0] === open[0] &&
    fence.length >= open.length &&
    rest.trim() === ''
    ? null
    : open;
}

/** `markdown` with a code fence that is still open at its end closed, for showing text
 * that is still arriving: a half-written block then renders as the code block it is going
 * to be. A trailing line that is the start of the closing fence (two of its three
 * backticks, say) is replaced by the whole fence rather than shown as code. Text with no
 * open fence comes back unchanged. */
export function closeOpenFence(markdown: string): string {
  // The open fence and the line it opened on, or null outside a code block.
  let open: { fence: string; at: number } | null = null;
  const lines = markdown.split('\n');
  for (const [at, line] of lines.entries()) {
    const fence = fenceAfter(open?.fence ?? null, line);
    if (fence === null) open = null;
    else if (open === null) open = { fence, at };
  }
  if (open === null) return markdown;
  const { fence, at } = open;
  const last = lines.length - 1;
  const tail = lines[last].replace(/^ {0,3}/, '').trimEnd();
  if (last > at && /^(`+|~+)$/.test(tail) && tail[0] === fence[0]) {
    return [...lines.slice(0, last), fence].join('\n');
  }
  return `${markdown}${markdown.endsWith('\n') ? '' : '\n'}${fence}`;
}

/** `markdown` that is still arriving, split into the Markdown blocks that are finished
 * and the one still open (`tail`). A block ends at a blank line outside a code fence once
 * the line after it starts at the left margin: an indented line (a list item's next
 * paragraph, an indented code block) continues what is above it. Each finished block
 * keeps its blank lines, so the blocks and the tail joined with line breaks are the text,
 * and a block never changes as the text grows by appending, so it can be drawn once. */
export function splitSettledMarkdown(markdown: string): {
  settled: string[];
  tail: string;
} {
  const lines = markdown.split('\n');
  const settled: string[] = [];
  let start = 0;
  // Whether the open block has a line that is not blank yet, and whether the last line
  // was a blank one outside a code fence.
  let content = false;
  let blank = false;
  let open: string | null = null;
  for (const [at, line] of lines.entries()) {
    if (blank && content && line !== '' && !/^\s/.test(line)) {
      settled.push(lines.slice(start, at).join('\n'));
      start = at;
      content = false;
    }
    open = fenceAfter(open, line);
    blank = open === null && line.trim() === '';
    if (line.trim() !== '') content = true;
  }
  return { settled, tail: lines.slice(start).join('\n') };
}

// One finished block of a `blocks` text, drawn again only when its text or the caller's
// render function changes.
const SettledBlock = memo(function SettledBlock({
  text,
  render,
}: {
  text: string;
  render: (text: string) => ReactNode;
}) {
  return render(text);
});

const NO_BLOCKS: string[] = [];

/** Streamed answer text: a word-boundary-aware reveal of what `text` grows by (the text
 * it mounts with shows at once — see `useStreamedText`) with a blinking caret, or the
 * caller's own `render` of it, inline numbered source chips, an actions slot for
 * copy/regenerate controls, and follow-up suggestion buttons. Extras stay hidden until
 * the reveal finishes. Under reduced motion the hook shows the whole text at once and
 * the caret is never drawn (it shows only under prefers-reduced-motion: no-preference,
 * see transcript.module.css). */
export function StreamingText({
  text,
  streaming,
  render,
  blocks = false,
  sources = [],
  followUps = [],
  onFollowUp,
  actions,
}: StreamingTextProps) {
  const { settled, tail } = useMemo(
    () =>
      blocks && render !== undefined
        ? splitSettledMarkdown(text)
        : { settled: NO_BLOCKS, tail: text },
    [blocks, render, text]
  );
  const shown = useStreamedText(tail, { enabled: streaming });
  const done = shown.length >= tail.length;

  return (
    <div
      className={styles.streaming}
      data-slot={blocks ? 'streaming-blocks' : undefined}
    >
      {render !== undefined &&
        settled.map((block, index) => (
          <SettledBlock key={index} text={block} render={render} />
        ))}
      {render !== undefined ? (
        render(closeOpenFence(shown))
      ) : (
        <p className={styles.streamingText}>
          {shown}
          {!done && <span aria-hidden="true" className={styles.caret} />}
        </p>
      )}

      {done && actions && <div className={styles.streamActions}>{actions}</div>}

      {done && sources.length > 0 && (
        <div className={styles.sources}>
          {sources.map((source, index) => (
            <SourceChip key={source.id} index={index} source={source} />
          ))}
        </div>
      )}

      {done && followUps.length > 0 && (
        <div className={styles.followUps}>
          <p className={styles.followUpsLabel}>Follow-ups</p>
          <div className={styles.followUpList}>
            {followUps.map((followUp) => (
              <Button
                key={followUp}
                size="sm"
                className={styles.followUp}
                icon={<CornerDownLeft size={14} strokeWidth={1.8} />}
                onClick={() => onFollowUp?.(followUp)}
              >
                {followUp}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
