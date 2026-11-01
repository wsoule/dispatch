import type { NormalizedEntry } from '@dispatch/client';
import { Bot, Brain, Check, Copy } from 'lucide-react';
import { useState } from 'react';

import { cardRaw } from '../../lib/cardContent';
import { CardErrorBoundary } from '../shell/CardErrorBoundary';
import { Markdown } from './Markdown';
import { toolView } from './ToolCard';
import type { GutterTone } from '@/lib/transcriptGutter';
import { gutterTone } from '@/lib/transcriptGutter';
import { cn } from '@/lib/utils';
import { IconButton } from '@/ui/ai/icon-button';
import { StreamingText } from '@/ui/ai/streaming-text';
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
 * One entry in the transcript, laid out like T3 Code's timeline.
 *
 * Tool calls, sub-agents and thinking are flat one-line rows (`ToolChip` variant `row`) whose
 * fixed icon column keeps the *shape* of a session scannable — five reads, a think, two edits,
 * a test run — without reading any of it; each opens in place to its detail. The agent's own
 * prose is unboxed Markdown. StreamingText only takes over for the one entry genuinely still
 * arriving (`live`), so the reveal effect never fabricates streaming for a settled transcript.
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
  const tone = gutterTone(entry);

  if (entry.kind === 'tool') {
    return (
      <div className="min-w-0">
        <ToolRow entry={entry} live={live} />
      </div>
    );
  }

  if (entry.kind === 'agent') {
    return (
      <div className="min-w-0">
        <AgentRow entry={entry} />
      </div>
    );
  }

  if (entry.kind === 'thinking') {
    return (
      <div className="min-w-0">
        <ThinkingEntryRow entry={entry} live={live} />
      </div>
    );
  }

  if (entry.kind === 'assistant' && live) {
    // Only the genuinely-live entry goes through StreamingText, which reveals what it grows
    // by and shows the text it arrived with at once; it renders through the same Markdown
    // as the settled branch below, so the entry looks the same once it stops being live.
    // A CLI agent's joined stdout (`chunk`) holds everything it has printed and grows with
    // every read, so it is drawn block by block: a read re-parses the open block only.
    return (
      <div className="min-w-0 px-1 py-0.5">
        <StreamingText
          text={entry.text ?? ''}
          streaming
          blocks={entry.chunk === true}
          render={renderProse}
        />
      </div>
    );
  }

  // Only 'assistant'/'system'/'usage'/'message' reach here — 'tool' and 'thinking' both
  // returned above.
  const isProse = entry.kind === 'assistant';

  return (
    <div className="group/assistant min-w-0 px-1 py-0.5">
      {isProse ? (
        <>
          <AssistantProse text={entry.text ?? ''} />
          <AssistantFooter text={entry.text ?? ''} ts={entry.ts} />
        </>
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

// Clock time for a reply's footer ("14:05"), or nothing for a missing/unparseable stamp.
function clockTime(ts: string): string | undefined {
  const at = Date.parse(ts);
  if (!Number.isFinite(at)) return undefined;
  return new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

// T3 Code's reply footer: copy and the time, hidden until the reply is hovered or the copy
// button takes focus, so a settled transcript stays quiet.
function AssistantFooter({ text, ts }: { text: string; ts: string }) {
  const [copied, setCopied] = useState(false);
  const time = clockTime(ts);
  return (
    <div
      data-slot="assistant-footer"
      className="text-muted-foreground -mb-1 flex h-5 items-center gap-1 opacity-0 transition-opacity duration-200 group-hover/assistant:opacity-100 focus-within:opacity-100"
    >
      <IconButton
        label={copied ? 'Copied' : 'Copy reply'}
        className="size-5"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => setCopied(true));
        }}
      >
        {copied ? (
          <Check aria-hidden className="text-green size-3.5" />
        ) : (
          <Copy aria-hidden className="size-3.5" />
        )}
      </IconButton>
      {time !== undefined && (
        <span className="font-book text-[12px] tabular-nums">{time}</span>
      )}
    </div>
  );
}

// The agent's own prose: unboxed, slightly softened foreground, relaxed leading. The chat
// lane (RunLogView) gives it its measure.
function AssistantProse({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  return (
    <Markdown
      content={text}
      streaming={streaming}
      className="font-book text-foreground/90 text-[13px] leading-relaxed"
    />
  );
}

// StreamingText's `render` for a live reply, one function for the module's life, so the
// finished blocks of a `blocks` text are drawn once. New blocks fade in (`streaming`).
const renderProse = (text: string) => <AssistantProse text={text} streaming />;

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
      variant="row"
      expandable={hasBody}
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
      <CollapsibleContent className="ms-7 min-w-0 pb-1">
        {view.body}
      </CollapsibleContent>
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
      variant="row"
      expandable={body !== undefined}
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
      <CollapsibleContent className="ms-7 min-w-0 pb-1">
        {body}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** One `thinking` entry as T3 Code's thinking row: a brain icon and a label that shines
 * while `live`, opening in place to the agent's raw reasoning. Collapsed by default so
 * verbose reasoning never crowds the timeline. */
function ThinkingEntryRow({
  entry,
  live,
}: {
  entry: NormalizedEntry;
  live: boolean;
}) {
  const [open, setOpen] = useState(false);
  const text = entry.text ?? '';
  const chip = (
    <ToolChip
      variant="row"
      expandable={text !== ''}
      icon={Brain}
      label={live ? 'Thinking' : 'Thought'}
      state={live ? 'running' : 'done'}
    />
  );
  if (text === '') return <div className="flex min-w-0">{chip}</div>;
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="flex min-w-0 flex-col gap-1"
    >
      <CollapsibleTrigger render={chip} />
      <CollapsibleContent className="ms-7 min-w-0 pb-1">
        <p className="text-muted-foreground font-book max-h-96 overflow-auto text-[12px] leading-relaxed whitespace-pre-wrap">
          {text}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}
