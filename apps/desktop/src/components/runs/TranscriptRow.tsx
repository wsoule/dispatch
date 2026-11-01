import type { NormalizedEntry } from '@dispatch/client';
import { Bot } from 'lucide-react';
import { useState } from 'react';

import { cardRaw } from '../../lib/cardContent';
import { CardErrorBoundary } from '../shell/CardErrorBoundary';
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
export function TranscriptRow(props: {
  entry: NormalizedEntry;
  live?: boolean;
}) {
  // One entry that fails to draw becomes a compact fallback row; the rest of
  // the transcript keeps rendering.
  return (
    <CardErrorBoundary raw={cardRaw(props.entry)}>
      <TranscriptRowContent {...props} />
    </CardErrorBoundary>
  );
}

function TranscriptRowContent({
  entry,
  live = false,
}: {
  entry: NormalizedEntry;
  /** True only while the run is genuinely still producing output (`meta.state === 'running'`)
   * for its current last entry, or a tool call still waiting on its result — see
   * `RunLogView`. Drives `StreamingText`'s reveal, `Thinking`'s active shimmer and a tool
   * chip's running state; never inferred from anything but the run's real state. */
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

  if (entry.kind === 'agent') {
    return (
      <div className="grid grid-cols-[52px_minmax(0,1fr)] gap-3 py-0.5">
        <GutterCell tag={tag} tone={tone} />
        <AgentRow entry={entry} />
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
    // Only the genuinely-live entry goes through StreamingText, which reveals what it grows
    // by and shows the text it arrived with at once; it renders through the same Markdown
    // as the settled branch below, so the entry looks the same once it stops being live.
    return (
      <div className="grid grid-cols-[52px_minmax(0,1fr)] gap-3 py-0.5">
        <GutterCell tag={tag} tone={tone} />
        <StreamingText
          text={entry.text ?? ''}
          streaming
          render={(text) => <AssistantProse text={text} />}
        />
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
        <AssistantProse text={entry.text ?? ''} />
      ) : (
        <span
          className={cn('text-[12px] leading-relaxed font-book', TONE[tone])}
        >
          {entry.text ?? ''}
        </span>
      )}
    </div>
  );
}

// The agent's own prose. It gets a measure: a transcript that runs the full width of a wide
// window is unreadable however well it is typeset.
function AssistantProse({ text }: { text: string }) {
  return (
    <Markdown
      content={text}
      className="font-book max-w-[68ch] text-[13px] leading-relaxed"
    />
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
        'text-muted-foreground pt-0.5 text-right text-[12px] font-medium',
        tone === 'accent' && 'text-accent-foreground',
        tone === 'bad' && 'text-state-failed',
        tone === 'good' && 'text-state-review'
      )}
    >
      {tag}
    </span>
  );
}

// A tool entry's `status` is the call's outcome once its result is folded in (groupLogEntries),
// and trusted outright then. A call with none yet is logged `running`, which alone is no live
// signal: some calls never get a result (a sub-agent's own, any call on an older daemon), and
// trusting it would shimmer every one of those forever. So it only counts as `running` while
// RunLogView says it is `live`.
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
      <CollapsibleTrigger render={chip} />
      <CollapsibleContent className="min-w-0">{view.body}</CollapsibleContent>
    </Collapsible>
  );
}

/** What a sub-agent lifecycle entry's chip says, by phase and outcome. */
function agentVerb(entry: NormalizedEntry): string {
  const agent = entry.agent;
  if (agent === undefined || agent.phase === 'started') return 'Spawned';
  switch (agent.status) {
    case 'failed':
      return 'Agent failed';
    case 'stopped':
      return 'Agent stopped';
    default:
      return 'Agent finished';
  }
}

/**
 * A sub-agent spawning or reporting back. The chip names the sub-agent (its
 * task description, then its type); opening a spawn shows the prompt it was
 * given, opening a finish shows its report and totals. Progress ticks never
 * reach here — `groupLogEntries` drops them — so the transcript keeps two
 * lines per sub-agent however busy it was; the fan-out tree above the log
 * carries the live detail.
 */
function AgentRow({ entry }: { entry: NormalizedEntry }) {
  const [open, setOpen] = useState(false);
  const agent = entry.agent;
  const label = agent?.label ?? agent?.id ?? 'sub-agent';
  const prompt =
    agent?.phase === 'started' &&
    typeof entry.toolInput === 'object' &&
    entry.toolInput !== null
      ? (entry.toolInput as { prompt?: unknown }).prompt
      : undefined;
  const state: ToolChipState =
    agent?.status === 'failed' || agent?.status === 'stopped'
      ? 'failed'
      : 'done';
  const totals = [
    agent?.toolUses !== undefined
      ? `${agent.toolUses} ${agent.toolUses === 1 ? 'tool call' : 'tool calls'}`
      : null,
    agent?.durationMs !== undefined
      ? `${Math.max(1, Math.round(agent.durationMs / 1000))}s`
      : null,
  ].filter((part): part is string => part !== null);
  const body =
    typeof prompt === 'string' && prompt !== '' ? (
      <Markdown
        content={prompt}
        className="font-book max-w-[68ch] text-[13px]"
      />
    ) : agent?.phase === 'finished' &&
      (agent.summary !== undefined || totals.length > 0) ? (
      <div className="font-book flex max-w-[68ch] flex-col gap-1 text-[13px]">
        {agent.summary !== undefined && (
          <Markdown content={agent.summary} className="font-book text-[13px]" />
        )}
        {totals.length > 0 && (
          <span className="text-muted-foreground font-book text-[12px] tabular-nums">
            {totals.join(' · ')}
          </span>
        )}
      </div>
    ) : undefined;

  const chip = (
    <ToolChip
      icon={Bot}
      label={agentVerb(entry)}
      meta={
        <span className="max-w-[40ch] truncate font-sans">
          {label}
          {agent?.type !== undefined ? ` · ${agent.type}` : ''}
        </span>
      }
      state={state}
    />
  );
  if (body === undefined) return <div className="flex min-w-0">{chip}</div>;
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="flex min-w-0 flex-col gap-1"
    >
      <CollapsibleTrigger render={chip} />
      <CollapsibleContent className="min-w-0">{body}</CollapsibleContent>
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
