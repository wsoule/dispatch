import { CornerDownLeftIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { useStreamedText } from './use-streamed-text';

export type StreamingTextSource = {
  id: string;
  label: string;
  href?: string;
};

export type StreamingTextProps = {
  text: string;
  streaming: boolean;
  /** Draws the revealed text, e.g. through the app's Markdown component, so formatting
   * shows while the text streams instead of popping in at the end. It gets the text with
   * an unterminated code fence closed (see `closeOpenFence`), and owns the typography:
   * nothing is added around it, so a streamed row can look exactly like the settled row
   * that replaces it. No caret is drawn, since a rendered block has no inline end to put
   * one on. Without it the text is a plain paragraph with a typing caret. */
  render?: (text: string) => ReactNode;
  sources?: StreamingTextSource[];
  followUps?: string[];
  onFollowUp?: (followUp: string) => void;
  actions?: ReactNode;
};

const CHIP_CLASS =
  'ease-out-expo rounded-chip bg-surface-inset text-muted-foreground hover:bg-surface-hover inline-flex items-center gap-1 px-1.5 py-0.5 text-[11.5px] font-medium transition-colors duration-100';

// One numbered citation chip. Renders as a link when the source has a URL, otherwise a
// plain button so the row still reads as interactive and stays keyboard-focusable.
function SourceChip({
  index,
  source,
}: {
  index: number;
  source: StreamingTextSource;
}) {
  const content = (
    <>
      <sup className="font-book text-[9px] leading-none">{index + 1}</sup>
      {source.label}
    </>
  );

  return source.href ? (
    <a
      href={source.href}
      target="_blank"
      rel="noreferrer"
      className={CHIP_CLASS}
    >
      {content}
    </a>
  ) : (
    <button type="button" className={CHIP_CLASS}>
      {content}
    </button>
  );
}

// A line that opens or closes a fenced code block: up to three spaces, then three or more
// backticks or tildes, then (for an opener) an info string.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

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
    const match = FENCE.exec(line);
    if (match === null) continue;
    const [, fence, rest] = match;
    if (open === null) {
      // A backtick fence's info string may not hold a backtick (CommonMark).
      if (fence[0] !== '`' || !rest.includes('`')) open = { fence, at };
    } else if (
      fence[0] === open.fence[0] &&
      fence.length >= open.fence.length &&
      rest.trim() === ''
    ) {
      open = null;
    }
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

/** Streamed answer text: a word-boundary-aware reveal of what `text` grows by (the text
 * it mounts with shows at once — see `useStreamedText`) with a blinking caret (hidden once
 * done or under reduced motion), or the caller's own `render` of it, inline numbered
 * source chips, an actions slot for copy/regenerate controls, and follow-up suggestion
 * buttons. Extras stay hidden until the reveal finishes, matching the showcase's
 * "Streaming Text" primitive where they fade in only after the answer lands. */
export function StreamingText({
  text,
  streaming,
  render,
  sources = [],
  followUps = [],
  onFollowUp,
  actions,
}: StreamingTextProps) {
  const shown = useStreamedText(text, { enabled: streaming });
  const done = shown.length >= text.length;

  return (
    <div className="flex w-full flex-col">
      {render !== undefined ? (
        render(closeOpenFence(shown))
      ) : (
        <p className="text-foreground text-[13px] leading-relaxed">
          {shown}
          {!done && (
            <span
              aria-hidden="true"
              className="bg-foreground ml-0.5 inline-block h-3 w-0.5 translate-y-0.5 animate-[caret-blink_1s_step-end_infinite] rounded-full motion-reduce:hidden"
            />
          )}
        </p>
      )}

      {done && actions && (
        <div className="mt-2 flex items-center gap-0.5">{actions}</div>
      )}

      {done && sources.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {sources.map((source, index) => (
            <SourceChip key={source.id} index={index} source={source} />
          ))}
        </div>
      )}

      {done && followUps.length > 0 && (
        <div className="mt-2.5 flex flex-col">
          <p className="text-muted-foreground text-[12px] font-medium">
            Follow-ups
          </p>
          <div className="mt-1 flex flex-col gap-1.5">
            {followUps.map((followUp) => (
              <button
                key={followUp}
                type="button"
                onClick={() => onFollowUp?.(followUp)}
                className="rounded-control shadow-btn bg-card hover:bg-surface-hover text-foreground ease-out-expo flex items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] transition-colors duration-100"
              >
                <CornerDownLeftIcon
                  aria-hidden
                  className="text-muted-foreground size-3 shrink-0"
                />
                {followUp}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
