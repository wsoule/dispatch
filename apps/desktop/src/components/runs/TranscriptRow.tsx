import type { NormalizedEntry } from '@dispatch/client';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';

import { Markdown } from './Markdown';
import { toolView } from './ToolCard';
import type { GutterTone } from '@/lib/transcriptGutter';
import { gutterTag, gutterTone } from '@/lib/transcriptGutter';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/collapsible';

const TONE: Record<GutterTone, string> = {
  muted: 'text-muted-foreground',
  normal: 'text-foreground',
  accent: 'text-accent-foreground',
  good: 'text-state-review',
  bad: 'text-state-failed',
};

/**
 * One entry in the transcript.
 *
 * The gutter tag is kept because it does something no other layout does: a fixed-width column
 * of read/edit/run/think makes the *shape* of a session scannable — five reads, a think, two
 * edits, a test run — without reading any of it.
 *
 * What the first version of this got wrong was rendering every kind as raw monospace, which
 * turned the agent's own prose into a wall of unformatted text and flattened tool calls into
 * one-liners you could not open. So the two are separated here: tool activity stays terse and
 * mono (it is machine output, and the point is to skim it), while anything the agent or a human
 * actually *wrote* renders as prose through Markdown, at a readable measure.
 */
export function TranscriptRow({ entry }: { entry: NormalizedEntry }) {
  const tag = gutterTag(entry);
  const tone = gutterTone(entry);
  const isProse = entry.kind === 'assistant' || entry.kind === 'thinking';

  return (
    <div className="grid grid-cols-[52px_minmax(0,1fr)] gap-3 py-0.5">
      <span
        className={cn(
          'dense-label pt-0.5 text-right',
          tone === 'accent' && 'text-accent-foreground',
          tone === 'bad' && 'text-state-failed',
          tone === 'good' && 'text-state-review'
        )}
      >
        {tag}
      </span>
      {entry.kind === 'tool' ? (
        <ToolRow entry={entry} tone={tone} />
      ) : isProse ? (
        // Prose gets a measure. A transcript that runs the full width of a wide window is
        // unreadable however well it is typeset.
        <Markdown
          content={entry.text ?? ''}
          className={cn(
            'max-w-[68ch] text-[13px] leading-relaxed',
            entry.kind === 'thinking' && 'text-muted-foreground'
          )}
        />
      ) : (
        <span className={cn('text-[12px] leading-relaxed', TONE[tone])}>
          {entry.text ?? ''}
        </span>
      )}
    </div>
  );
}

/**
 * A tool call: its one-line summary, expandable to the full input.
 *
 * Collapsed by default because the summary — the path read, the command run — is the answer
 * nine times out of ten, and the tenth is why it opens.
 */
function ToolRow({
  entry,
  tone,
}: {
  entry: NormalizedEntry;
  tone: GutterTone;
}) {
  const view = toolView(entry);
  const [open, setOpen] = useState(view.defaultOpen ?? false);
  const hasBody = view.body !== undefined;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="flex min-w-0 flex-col"
    >
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          disabled={!hasBody}
          className={cn(
            'h-auto w-full min-w-0 shrink justify-start gap-1.5 p-0 text-left font-mono text-[12px] font-normal hover:bg-transparent',
            hasBody && 'hover:text-foreground',
            TONE[tone]
          )}
        >
          {hasBody &&
            (open ? (
              <ChevronDown className="size-3 shrink-0 opacity-60" />
            ) : (
              <ChevronRight className="size-3 shrink-0 opacity-60" />
            ))}
          <span className="text-muted-foreground shrink-0">{view.icon}</span>
          <span className="truncate">{view.target ?? view.verb}</span>
        </Button>
      </CollapsibleTrigger>
      {hasBody && (
        <CollapsibleContent className="mt-1 min-w-0">
          {view.body}
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
