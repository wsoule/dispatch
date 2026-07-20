import type { NormalizedEntry, RunMeta } from '@dispatch/client';

// One renderable chunk of a run's log: either a single chat-style bubble
// (an assistant/thinking/system entry, one per group) or a cluster of
// consecutive tool-call entries collapsed under one header — the "chat-style
// normalized log with collapsible tool entries" the plan asks for. Grouping
// consecutive tool calls (rather than rendering each as its own top-level
// bubble) keeps a turn where an agent fires several tool calls in a row from
// dominating the log with repeated chrome.
export interface LogGroup {
  kind: 'message' | 'tools';
  entries: NormalizedEntry[];
}

// Splits a run's flat entry list into LogGroups for rendering. `usage`
// entries are excluded here — they don't render as log lines at all, only
// feed `liveCostUsd` below — everything else becomes its own group, except
// runs of consecutive `tool` entries, which collapse into one `tools` group
// so the log view can render them as a single collapsible cluster.
export function groupLogEntries(entries: NormalizedEntry[]): LogGroup[] {
  const groups: LogGroup[] = [];
  for (const entry of entries) {
    if (entry.kind === 'usage') continue;
    const groupKind: LogGroup['kind'] =
      entry.kind === 'tool' ? 'tools' : 'message';
    const last = groups[groups.length - 1];
    if (last !== undefined && last.kind === 'tools' && groupKind === 'tools') {
      last.entries.push(entry);
    } else {
      groups.push({ kind: groupKind, entries: [entry] });
    }
  }
  return groups;
}

// Parses one `usage`-kind entry's `text` for a running cost figure. No
// executor emits `usage` entries yet (O1's FakeExecutor scripts and O2's
// ClaudeExecutor both only ever set RunMeta.costUsd once a run finishes) —
// this exists so a live cost ticker already works the moment one does,
// and so a FakeExecutor smoke script can simulate one today by scripting a
// step with `entry: { kind: 'usage', text: '{"costUsd":0.12}' }`. Accepts
// either a small JSON object (`{"costUsd":0.12}`) or a bare/dollar-prefixed
// number ("$0.12", "0.12") so a hand-written script doesn't have to bother
// with JSON just to move the ticker.
function parseUsageCost(text: string): number | null {
  try {
    const data = JSON.parse(text) as { costUsd?: unknown };
    if (typeof data.costUsd === 'number') return data.costUsd;
  } catch {
    // Not JSON — fall through to the plain-number/dollar-string form below.
  }
  const match = /\$?(\d+(?:\.\d+)?)/.exec(text);
  return match ? Number(match[1]) : null;
}

// The cost figure a run's rail/header ticker should show right now:
// RunMeta.costUsd once it's known (a run only gets one once it's finished),
// otherwise the most recently reported `usage` entry's cost, otherwise
// `null` (nothing to show yet — a live run with no usage entries).
export function liveCostUsd(
  meta: Pick<RunMeta, 'costUsd'>,
  entries: NormalizedEntry[]
): number | null {
  if (meta.costUsd !== undefined) return meta.costUsd;
  let latest: number | null = null;
  for (const entry of entries) {
    if (entry.kind !== 'usage' || entry.text === undefined) continue;
    const parsed = parseUsageCost(entry.text);
    if (parsed !== null) latest = parsed;
  }
  return latest;
}

// A one-line summary for a tool entry's collapsed header, e.g. `Bash({"command":"ls"})`
// truncated so a large payload (a big file write) never blows out the log's layout.
const TOOL_INPUT_PREVIEW_MAX = 80;

export function toolEntryPreview(entry: NormalizedEntry): string {
  const name = entry.toolName ?? 'tool';
  if (entry.toolInput === undefined) return name;
  let inputText: string;
  try {
    inputText = JSON.stringify(entry.toolInput);
  } catch {
    inputText = String(entry.toolInput);
  }
  const truncated =
    inputText.length > TOOL_INPUT_PREVIEW_MAX
      ? `${inputText.slice(0, TOOL_INPUT_PREVIEW_MAX)}…`
      : inputText;
  return `${name}(${truncated})`;
}
