import type { NormalizedEntry } from '@dispatch/client';
import { CodeBlock } from '@dispatch/ui';
import {
  FilePen,
  FilePlus,
  FileText,
  Globe,
  ListTodo,
  type LucideIcon,
  Search,
  Terminal,
  Wrench,
} from 'lucide-react';
import type { ReactNode } from 'react';

import styles from './ToolCard.module.css';

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

// A red/green block diff for an Edit's old->new strings. Not a real line-level LCS diff — the
// SDK already hands us the exact old and new blocks an edit replaces, and showing them stacked
// (removed then added) is how Claude Code itself renders an edit, so this mirrors that with no
// diffing needed. Each line carries its sign as text, so the diff reads without its tints.
function EditDiff({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  const removed = oldStr === '' ? [] : oldStr.split('\n');
  const added = newStr === '' ? [] : newStr.split('\n');
  return (
    <div className={styles.scroll} data-slot="edit-diff">
      <pre className={styles.diff}>
        {removed.map((line, i) => (
          <div
            key={`r${i}`}
            data-tone="danger"
            data-diff="del"
            className={styles.line}
          >
            <span className={styles.sign}>- </span>
            {line}
          </div>
        ))}
        {added.map((line, i) => (
          <div
            key={`a${i}`}
            data-tone="success"
            data-diff="ins"
            className={styles.line}
          >
            <span className={styles.sign}>+ </span>
            {line}
          </div>
        ))}
      </pre>
    </div>
  );
}

// A tool's raw text payload (a Write's file contents, a fallback JSON dump) in the library
// CodeBlock, capped so a large payload never blows out the transcript's height, with Copy.
function Payload({ text, language }: { text: string; language?: string }) {
  return (
    <CodeBlock code={text} language={language} maxHeight={240} wrap copy />
  );
}

export interface ToolView {
  /** A component reference, not a rendered element — `ToolChip` (the transcript row's
   * click-through trigger) sizes and colors the icon itself. */
  icon: LucideIcon;
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
/** Exported so the transcript row can render the same summary and body without duplicating the
 * per-tool knowledge, which is the only place that mapping should live. */
export function toolView(entry: NormalizedEntry): ToolView {
  const name = entry.toolName ?? 'tool';
  const input = entry.toolInput;
  const filePath = field(input, 'file_path');

  switch (name) {
    case 'Edit':
    case 'MultiEdit': {
      const oldStr = field(input, 'old_string') ?? '';
      const newStr = field(input, 'new_string') ?? '';
      return {
        icon: FilePen,
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
        icon: FilePlus,
        verb: 'Write',
        target: filePath,
        body: content !== undefined ? <Payload text={content} /> : undefined,
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
        icon: FileText,
        verb: 'Read',
        target: filePath !== undefined ? `${filePath}${range}` : undefined,
      };
    }
    case 'Bash': {
      const command = field(input, 'command');
      return {
        icon: Terminal,
        verb: 'Run',
        target: command,
      };
    }
    case 'Grep':
    case 'Glob': {
      const pattern = field(input, 'pattern');
      const path = field(input, 'path');
      return {
        icon: Search,
        verb: name === 'Grep' ? 'Search' : 'Find',
        target:
          pattern !== undefined
            ? `${pattern}${path !== undefined ? ` in ${path}` : ''}`
            : path,
      };
    }
    case 'TodoWrite':
      return {
        icon: ListTodo,
        verb: 'Update todos',
      };
    case 'WebFetch':
    case 'WebSearch':
      return {
        icon: Globe,
        verb: name === 'WebFetch' ? 'Fetch' : 'Search web',
        target: field(input, 'url') ?? field(input, 'query'),
      };
    default: {
      let json: string | undefined;
      if (input !== undefined) {
        try {
          json = JSON.stringify(input, null, 2);
        } catch {
          // Only a cyclic input lands here, and it has no useful text form.
          json = '(input could not be displayed)';
        }
      }
      return {
        icon: Wrench,
        verb: name,
        body:
          json !== undefined ? (
            <Payload text={json} language="JSON" />
          ) : undefined,
      };
    }
  }
}
