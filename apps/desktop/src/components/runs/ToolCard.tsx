import type { NormalizedEntry } from '@dispatch/client';
import {
  ChevronDown,
  ChevronRight,
  FilePen,
  FilePlus,
  FileText,
  Globe,
  ListTodo,
  Search,
  Terminal,
  Wrench,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';

// Reads a string field off a tool entry's `toolInput` (typed `unknown` — it's whatever the
// executor forwarded from the SDK), returning undefined for anything that isn't a present
// string so a malformed/absent field just degrades to "no detail" rather than throwing.
function field(input: unknown, key: string): string | undefined {
  if (input !== null && typeof input === 'object' && key in input) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

// The trailing path segment, so a long absolute file path can show its basename prominently
// with the rest as muted context.
function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

// A red/green block diff for an Edit's old->new strings. Not a real line-level LCS diff — the
// SDK already hands us the exact old and new blocks an edit replaces, and showing them stacked
// (removed then added) is how Claude Code itself renders an edit, so this mirrors that with no
// diffing needed.
function EditDiff({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  const removed = oldStr === '' ? [] : oldStr.split('\n');
  const added = newStr === '' ? [] : newStr.split('\n');
  return (
    <pre className="border-border/60 max-h-64 overflow-auto rounded-md border font-mono text-[11.5px] leading-snug">
      {removed.map((line, i) => (
        <div
          key={`r${i}`}
          className="bg-destructive/10 text-destructive px-2 whitespace-pre-wrap"
        >
          <span className="opacity-60 select-none">- </span>
          {line}
        </div>
      ))}
      {added.map((line, i) => (
        <div
          key={`a${i}`}
          className="bg-emerald-500/10 px-2 whitespace-pre-wrap text-emerald-600 dark:text-emerald-400"
        >
          <span className="opacity-60 select-none">+ </span>
          {line}
        </div>
      ))}
    </pre>
  );
}

// A capped, scrollable mono block for a tool's raw text payload (a Write's file contents, a
// fallback JSON dump) so a large payload never blows out the transcript's height.
function CodeBlock({ text }: { text: string }) {
  return (
    <pre className="bg-muted/50 border-border/60 max-h-64 overflow-auto rounded-md border p-2 font-mono text-[11.5px] leading-snug whitespace-pre-wrap">
      {text}
    </pre>
  );
}

interface ToolView {
  icon: ReactNode;
  verb: string;
  /** The one-line target shown next to the verb (a file path, command, or pattern). */
  target?: string;
  /** Expandable detail (a diff, file contents, args) — omitted for tools whose summary line
   * already says everything (Read, Grep, Glob). */
  body?: ReactNode;
  /** Whether `body`, when present, starts expanded — an Edit's diff is the signal so it opens
   * by default; a Write's full contents stay collapsed. */
  defaultOpen?: boolean;
}

// Maps one tool entry to how it should render — icon, verb, target line, and optional
// expandable body — keyed on the SDK tool name. Unknown tools fall back to their name plus a
// collapsed JSON dump of the input, so a tool this doesn't special-case still renders legibly.
function toolView(entry: NormalizedEntry): ToolView {
  const name = entry.toolName ?? 'tool';
  const input = entry.toolInput;
  const filePath = field(input, 'file_path');

  switch (name) {
    case 'Edit':
    case 'MultiEdit': {
      const oldStr = field(input, 'old_string') ?? '';
      const newStr = field(input, 'new_string') ?? '';
      return {
        icon: <FilePen className="size-3.5" />,
        verb: 'Edit',
        target: filePath,
        body:
          oldStr !== '' || newStr !== '' ? (
            <EditDiff oldStr={oldStr} newStr={newStr} />
          ) : undefined,
        defaultOpen: true,
      };
    }
    case 'Write': {
      const content = field(input, 'content');
      return {
        icon: <FilePlus className="size-3.5" />,
        verb: 'Write',
        target: filePath,
        body: content !== undefined ? <CodeBlock text={content} /> : undefined,
      };
    }
    case 'Read': {
      const offset = field(input, 'offset');
      const limit = field(input, 'limit');
      const range =
        offset !== undefined || limit !== undefined
          ? ` (${offset ?? '0'}–${limit ?? 'end'})`
          : '';
      return {
        icon: <FileText className="size-3.5" />,
        verb: 'Read',
        target: filePath !== undefined ? `${filePath}${range}` : undefined,
      };
    }
    case 'Bash': {
      const command = field(input, 'command');
      return {
        icon: <Terminal className="size-3.5" />,
        verb: 'Run',
        target: command,
      };
    }
    case 'Grep':
    case 'Glob': {
      const pattern = field(input, 'pattern');
      const path = field(input, 'path');
      return {
        icon: <Search className="size-3.5" />,
        verb: name === 'Grep' ? 'Search' : 'Find',
        target:
          pattern !== undefined
            ? `${pattern}${path !== undefined ? ` in ${path}` : ''}`
            : path,
      };
    }
    case 'TodoWrite':
      return {
        icon: <ListTodo className="size-3.5" />,
        verb: 'Update todos',
      };
    case 'WebFetch':
    case 'WebSearch':
      return {
        icon: <Globe className="size-3.5" />,
        verb: name === 'WebFetch' ? 'Fetch' : 'Search web',
        target: field(input, 'url') ?? field(input, 'query'),
      };
    default: {
      let json: string | undefined;
      if (input !== undefined) {
        try {
          json = JSON.stringify(input, null, 2);
        } catch {
          json = String(input);
        }
      }
      return {
        icon: <Wrench className="size-3.5" />,
        verb: name,
        body: json !== undefined ? <CodeBlock text={json} /> : undefined,
      };
    }
  }
}

/**
 * One tool call in the run transcript, rendered by tool type instead of as raw JSON: an
 * icon + verb + target line (file, command, or pattern), with an expandable body for the tools
 * whose detail is worth showing inline (an Edit's diff, a Write's contents). This is what makes
 * the Session tab read like Claude Code's own tool output rather than a JSON dump.
 */
export function ToolCard({ entry }: { entry: NormalizedEntry }) {
  const view = toolView(entry);
  const [open, setOpen] = useState(view.defaultOpen ?? false);
  const hasBody = view.body !== undefined;

  return (
    <div className="border-border/60 bg-card/40 flex max-w-[90%] flex-col gap-1.5 self-start rounded-md border px-2.5 py-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="text-muted-foreground shrink-0">{view.icon}</span>
        <span className="text-foreground shrink-0 text-[12px] font-medium">
          {view.verb}
        </span>
        {view.target !== undefined && (
          <span
            className="text-muted-foreground min-w-0 truncate font-mono text-[11.5px]"
            title={view.target}
          >
            {view.verb === 'Run' ||
            view.verb === 'Search' ||
            view.verb === 'Find'
              ? view.target
              : basename(view.target)}
          </span>
        )}
        {hasBody && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? 'Collapse detail' : 'Expand detail'}
            className="text-muted-foreground hover:text-foreground ml-auto shrink-0"
          >
            {open ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </button>
        )}
      </div>
      {hasBody && open && view.body}
    </div>
  );
}
