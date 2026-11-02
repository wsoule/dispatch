import type { NormalizedEntry } from '@dispatch/client';
import {
  Button,
  COPIED_MS,
  cx,
  Disclosure,
  writeClipboard,
} from '@dispatch/ui';
import { Bot, Check, Copy } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { cardRaw } from '../../lib/cardContent';
import { type GutterTone, gutterTone } from '../../lib/transcriptGutter';
import { CardErrorBoundary } from '../shell/CardErrorBoundary';
import { StreamingText } from '../transcript/StreamingText';
import { ThinkingTrace } from '../transcript/ThinkingTrace';
import { ToolChip, type ToolChipState } from '../transcript/ToolChip';
import { Markdown } from './Markdown';
import { toolView } from './ToolCard';
import styles from './TranscriptRow.module.css';

/** How a system line's words are coloured, from its gutter tone: a status (a command
 * that succeeded or failed) through `data-tone` and the global `.toneText`, the rest as
 * a plain text colour. */
const TONE_TEXT: Record<
  GutterTone,
  { className: string; tone?: 'success' | 'danger' }
> = {
  muted: { className: styles.muted },
  normal: { className: styles.normal },
  accent: { className: styles.accent },
  good: { className: 'toneText', tone: 'success' },
  bad: { className: 'toneText', tone: 'danger' },
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
   * `RunLogView`. Drives `StreamingText`'s reveal, `ThinkingTrace`'s shimmer and a tool
   * chip's running state; never inferred from anything but the run's real state. */
  live?: boolean;
}) {
  if (entry.kind === 'tool') {
    return (
      <div className={styles.row}>
        <ToolRow entry={entry} live={live} />
      </div>
    );
  }

  if (entry.kind === 'agent') {
    return (
      <div className={styles.row}>
        <AgentRow entry={entry} />
      </div>
    );
  }

  if (entry.kind === 'thinking') {
    return (
      <div className={styles.row}>
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
      <div className={styles.text}>
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
  if (entry.kind === 'assistant') {
    return (
      <div className={cx(styles.text, styles.reply)}>
        <AssistantProse text={entry.text ?? ''} />
        <AssistantFooter text={entry.text ?? ''} ts={entry.ts} />
      </div>
    );
  }

  const tone = TONE_TEXT[gutterTone(entry)];
  return (
    <div className={styles.text}>
      <span className={cx(styles.system, tone.className)} data-tone={tone.tone}>
        {entry.text ?? ''}
      </span>
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
// button takes focus, so a settled transcript stays quiet. "Copied" holds for the library's
// confirmation window, then the button offers the copy again.
function AssistantFooter({ text, ts }: { text: string; ts: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const time = clockTime(ts);

  async function copy() {
    if (!(await writeClipboard(text))) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  }

  return (
    <div data-slot="assistant-footer" className={styles.footer}>
      <Button
        variant="quiet"
        size="sm"
        aria-label={copied ? 'Copied' : 'Copy reply'}
        icon={
          copied ? (
            <Check size={14} strokeWidth={1.8} aria-hidden />
          ) : (
            <Copy size={14} strokeWidth={1.8} aria-hidden />
          )
        }
        onClick={() => void copy()}
      />
      {time !== undefined && (
        <span className={cx(styles.time, 'num')}>{time}</span>
      )}
    </div>
  );
}

// The agent's own prose: unboxed, at the long-read leading. The chat lane (RunLogView)
// gives it its measure.
function AssistantProse({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  return (
    <Markdown content={text} streaming={streaming} className={styles.prose} />
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

/** A ToolChip row that opens in place to `body`: the library Disclosure (no chrome of its
 * own) hands the row its aria-expanded and aria-controls, and the body sits indented under
 * the row's label. With no body the row is a plain chip. */
function FoldRow({
  chip,
  body,
  open,
  onOpenChange,
}: {
  chip: (trigger?: {
    expanded: boolean;
    'aria-controls': string;
    onClick: () => void;
  }) => ReactNode;
  body: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (body === undefined) return <div className={styles.plain}>{chip()}</div>;
  return (
    <Disclosure
      variant="plain"
      open={open}
      onOpenChange={onOpenChange}
      trigger={({ open: shown, props }) =>
        chip({
          expanded: shown,
          'aria-controls': props['aria-controls'],
          onClick: props.onClick,
        })
      }
    >
      <div className={styles.body}>{body}</div>
    </Disclosure>
  );
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
  const state = toolChipState(entry, live);

  return (
    <FoldRow
      open={open}
      onOpenChange={setOpen}
      body={view.body}
      chip={(trigger) => (
        <ToolChip
          variant="row"
          expandable={trigger !== undefined}
          expanded={trigger?.expanded}
          aria-controls={trigger?.['aria-controls']}
          onClick={trigger?.onClick}
          icon={view.icon}
          label={view.verb}
          meta={view.target}
          state={state}
        />
      )}
    />
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
      <Markdown content={prompt} className={styles.agentBody} />
    ) : agent?.phase === 'finished' &&
      (agent.summary !== undefined || totals.length > 0) ? (
      <div className={styles.agentReport}>
        {agent.summary !== undefined && (
          <Markdown content={agent.summary} className={styles.agentBody} />
        )}
        {totals.length > 0 && (
          <span className={cx(styles.totals, 'num')}>{totals.join(' · ')}</span>
        )}
      </div>
    ) : undefined;

  return (
    <FoldRow
      open={open}
      onOpenChange={setOpen}
      body={body}
      chip={(trigger) => (
        <ToolChip
          variant="row"
          expandable={trigger !== undefined}
          expanded={trigger?.expanded}
          aria-controls={trigger?.['aria-controls']}
          onClick={trigger?.onClick}
          icon={Bot}
          label={agentVerb(entry)}
          meta={
            <span className={styles.agentMeta}>
              {label}
              {agent?.type !== undefined ? ` · ${agent.type}` : ''}
            </span>
          }
          state={state}
        />
      )}
    />
  );
}

/** One `thinking` entry: ThinkingTrace, folded by default so verbose reasoning never
 * crowds the timeline; the fold state lives here so it survives the row re-rendering. */
function ThinkingEntryRow({
  entry,
  live,
}: {
  entry: NormalizedEntry;
  live: boolean;
}) {
  const [collapsed, setCollapsed] = useState(true);
  return (
    <ThinkingTrace
      text={entry.text ?? ''}
      live={live}
      collapsed={collapsed}
      onToggle={() => setCollapsed((value) => !value)}
    />
  );
}
