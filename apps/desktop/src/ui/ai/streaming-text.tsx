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
  sources?: StreamingTextSource[];
  followUps?: string[];
  onFollowUp?: (followUp: string) => void;
  actions?: ReactNode;
};

const CHIP_CLASS =
  'rounded-chip bg-surface-inset text-muted-foreground hover:bg-surface-hover inline-flex items-center gap-1 px-1.5 py-0.5 text-[11.5px] font-medium transition-colors duration-100';

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
      <sup className="font-mono text-[9px] leading-none">{index + 1}</sup>
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

/** Streamed answer text: a word-boundary-aware typing reveal with a blinking caret
 * (hidden once done or under reduced motion), inline numbered source chips, an actions
 * slot for copy/regenerate controls, and follow-up suggestion buttons. Extras stay
 * hidden until the reveal finishes, matching the showcase's "Streaming Text" primitive
 * where they fade in only after the answer lands. */
export function StreamingText({
  text,
  streaming,
  sources = [],
  followUps = [],
  onFollowUp,
  actions,
}: StreamingTextProps) {
  const shown = useStreamedText(text, { enabled: streaming });
  const done = shown.length >= text.length;

  return (
    <div className="flex w-full flex-col">
      <p className="text-foreground text-[13px] leading-relaxed">
        {shown}
        {!done && (
          <span
            aria-hidden="true"
            className="bg-foreground ml-0.5 inline-block h-3 w-0.5 translate-y-0.5 animate-[caret-blink_1s_step-end_infinite] rounded-full motion-reduce:hidden"
          />
        )}
      </p>

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
                className="rounded-control shadow-btn bg-card hover:bg-surface-hover text-foreground flex items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] transition-colors duration-100"
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
