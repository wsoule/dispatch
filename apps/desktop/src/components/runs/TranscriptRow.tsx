import type { NormalizedEntry } from '@dispatch/client';
import { useState } from 'react';

import { Markdown } from './Markdown';
import { toolView } from './ToolCard';
import type { GutterTone } from '@/lib/transcriptGutter';
import { gutterTag, gutterTone } from '@/lib/transcriptGutter';
import { cn } from '@/lib/utils';
import { StreamingText } from '@/ui/ai/streaming-text';
import type { ThinkingStep } from '@/ui/ai/thinking';
import { Thinking } from '@/ui/ai/thinking';
import type { ToolChipState } from '@/ui/ai/tool-chips';
import { ToolChip } from '@/ui/ai/tool-chips';
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
 * one-liners you could not open. So the two are separated here: tool activity renders as a
 * `ToolChip` (its expanded detail is the click-through), thinking as a collapsible `Thinking`
 * trace, and the agent's own prose as Markdown — StreamingText only takes over for the one
 * entry genuinely still arriving (`live`), so the reveal effect never fabricates streaming for
 * a transcript that's already settled.
 */
export function TranscriptRow({
  entry,
  live = false,
}: {
  entry: NormalizedEntry;
  /** True only for the run's current last entry while it's genuinely still producing output
   * (`meta.state === 'running'`) — see `RunLogView`. Drives `StreamingText`'s reveal and
   * `Thinking`'s active shimmer; never inferred from anything but the run's real state. */
  live?: boolean;
}) {
  const tag = gutterTag(entry);
  const tone = gutterTone(entry);

  if (entry.kind === 'tool') {
    return (
      <div className="grid grid-cols-[52px_minmax(0,1fr)] gap-3 py-0.5">
        <GutterCell tag={tag} tone={tone} />
        <ToolRow entry={entry} live={live} />
      </div>
    );
  }

  if (entry.kind === 'thinking') {
    return (
      <div className="grid grid-cols-[52px_minmax(0,1fr)] gap-3 py-0.5">
        <GutterCell tag={tag} tone={tone} />
        <ThinkingEntryRow entry={entry} live={live} />
      </div>
    );
  }

  if (entry.kind === 'assistant' && live) {
    // Only the genuinely-live entry gets the typing reveal — everything else (including this
    // same entry once it stops being live) renders as Markdown below, so formatting is never
    // sacrificed for history.
    return (
      <div className="grid grid-cols-[52px_minmax(0,1fr)] gap-3 py-0.5">
        <GutterCell tag={tag} tone={tone} />
        <StreamingText text={entry.text ?? ''} streaming />
      </div>
    );
  }

  // Only 'assistant'/'system'/'usage'/'message' reach here — 'tool' and 'thinking' both
  // returned above.
  const isProse = entry.kind === 'assistant';

  return (
    <div className="grid grid-cols-[52px_minmax(0,1fr)] gap-3 py-0.5">
      <GutterCell tag={tag} tone={tone} />
      {isProse ? (
        // Prose gets a measure. A transcript that runs the full width of a wide window is
        // unreadable however well it is typeset.
        <Markdown
          content={entry.text ?? ''}
          className="max-w-[68ch] text-[13px] leading-relaxed"
        />
      ) : (
        <span className={cn('text-[12px] leading-relaxed', TONE[tone])}>
          {entry.text ?? ''}
        </span>
      )}
    </div>
  );
}

function GutterCell({
  tag,
  tone,
}: {
  tag: ReturnType<typeof gutterTag>;
  tone: GutterTone;
}) {
  return (
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
  );
}

// A tool entry's own `status` is unreliable as a live signal — the Claude executor logs every
// tool call as `running` and never resolves it to `done` (see claude.ts's TODO(M7)), so trusting
// it directly would shimmer every historical tool call forever. `error` is still a real signal
// worth trusting outright; anything else only counts as `running` while this is the transcript's
// genuinely live edge.
function toolChipState(entry: NormalizedEntry, live: boolean): ToolChipState {
  if (entry.status === 'error') return 'failed';
  if (entry.status === 'done') return 'done';
  return live ? 'running' : 'done';
}

/**
 * A tool call: its chip summary, expandable to the full input via the same detail ToolCard
 * always rendered (a diff, file contents, raw args).
 *
 * Collapsed by default because the summary — the path read, the command run — is the answer
 * nine times out of ten, and the tenth is why it opens.
 */
function ToolRow({ entry, live }: { entry: NormalizedEntry; live: boolean }) {
  const view = toolView(entry);
  const [open, setOpen] = useState(view.defaultOpen ?? false);
  const hasBody = view.body !== undefined;
  const state = toolChipState(entry, live);

  const chip = (
    <ToolChip
      icon={view.icon}
      label={view.verb}
      meta={view.target}
      state={state}
    />
  );

  if (!hasBody) {
    return <div className="flex min-w-0">{chip}</div>;
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="flex min-w-0 flex-col gap-1"
    >
      <CollapsibleTrigger asChild>{chip}</CollapsibleTrigger>
      <CollapsibleContent className="min-w-0">{view.body}</CollapsibleContent>
    </Collapsible>
  );
}

/** One `thinking` entry as a `Thinking` trace: a single reasoning step carrying the agent's
 * raw text, shimmering while `live`. Collapsed by default, matching the primitive's own
 * convention of hiding verbose reasoning behind a chip rather than printing it inline. */
function ThinkingEntryRow({
  entry,
  live,
}: {
  entry: NormalizedEntry;
  live: boolean;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const steps: ThinkingStep[] = [
    {
      kind: 'reasoning',
      label: entry.text ?? '',
      state: live ? 'active' : 'done',
    },
  ];

  return (
    <Thinking
      steps={steps}
      collapsed={collapsed}
      onToggle={() => setCollapsed((c) => !c)}
    />
  );
}
