import { CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useStreamedText } from '@/ui/ai/use-streamed-text';

export type CodeBlockLanguage = 'ts' | 'tsx' | 'css' | 'json';

export type CodeBlockProps = {
  code: string;
  language: CodeBlockLanguage;
  /** File name shown in the header bar, e.g. `churn.ts`. Omitted entirely when absent. */
  filename?: string;
  /** Reveals `code` line by line via `useStreamedText` instead of rendering it whole. */
  streaming?: boolean;
  /** Notified with the full `code` string after a successful copy-to-clipboard. */
  onCopy?: (code: string) => void;
};

type CodeTokenKind = 'comment' | 'string' | 'keyword' | 'number' | 'plain';

export type CodeToken = {
  text: string;
  kind: CodeTokenKind;
};

const LANGUAGE_LABEL: Record<CodeBlockLanguage, string> = {
  ts: 'TypeScript',
  tsx: 'TSX',
  css: 'CSS',
  json: 'JSON',
};

// Minimal regex tokenizer for the gallery's three languages — no dependency on the
// Shiki instance @pierre/diffs ships, since that only runs inside its own worker pool
// wired to diff review (see PierreWorkerPool.tsx) and isn't importable standalone here.
const TS_KEYWORDS = [
  'const',
  'let',
  'var',
  'function',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'import',
  'export',
  'from',
  'default',
  'interface',
  'type',
  'extends',
  'implements',
  'class',
  'new',
  'async',
  'await',
  'try',
  'catch',
  'finally',
  'throw',
  'switch',
  'case',
  'break',
  'continue',
  'public',
  'private',
  'protected',
  'readonly',
  'static',
  'void',
  'null',
  'undefined',
  'true',
  'false',
  'this',
  'super',
  'typeof',
  'instanceof',
  'in',
  'of',
  'enum',
  'namespace',
  'declare',
  'as',
  'is',
  'keyof',
  'never',
  'unknown',
  'any',
  'string',
  'number',
  'boolean',
  'object',
  'symbol',
  'bigint',
];

const CSS_KEYWORDS = [
  'important',
  'inherit',
  'initial',
  'unset',
  'none',
  'auto',
  'flex',
  'grid',
  'block',
  'inline',
  'absolute',
  'relative',
  'fixed',
  'sticky',
  'solid',
  'dashed',
  'dotted',
  'center',
  'pointer',
  'hidden',
  'transparent',
  'currentColor',
];

type TokenRule = { kind: CodeTokenKind; pattern: string };

const TS_RULES: TokenRule[] = [
  { kind: 'comment', pattern: '//.*' },
  { kind: 'comment', pattern: '/\\*.*?\\*/' },
  { kind: 'string', pattern: '`(?:\\\\.|[^`\\\\])*`' },
  { kind: 'string', pattern: '"(?:\\\\.|[^"\\\\])*"' },
  { kind: 'string', pattern: "'(?:\\\\.|[^'\\\\])*'" },
  { kind: 'number', pattern: '\\b\\d+(?:\\.\\d+)?\\b' },
  { kind: 'keyword', pattern: `\\b(?:${TS_KEYWORDS.join('|')})\\b` },
];

const RULES: Record<CodeBlockLanguage, TokenRule[]> = {
  ts: TS_RULES,
  tsx: TS_RULES,
  css: [
    { kind: 'comment', pattern: '/\\*.*?\\*/' },
    { kind: 'string', pattern: '"(?:\\\\.|[^"\\\\])*"' },
    { kind: 'string', pattern: "'(?:\\\\.|[^'\\\\])*'" },
    { kind: 'keyword', pattern: '@[a-zA-Z-]+' },
    {
      kind: 'number',
      pattern: '-?\\b\\d+(?:\\.\\d+)?(?:px|rem|em|%|vh|vw|ms|s|fr|deg)?\\b',
    },
    { kind: 'keyword', pattern: `\\b(?:${CSS_KEYWORDS.join('|')})\\b` },
  ],
  json: [
    { kind: 'string', pattern: '"(?:\\\\.|[^"\\\\])*"' },
    { kind: 'number', pattern: '-?\\b\\d+(?:\\.\\d+)?\\b' },
    { kind: 'keyword', pattern: '\\b(?:true|false|null)\\b' },
  ],
};

const COMPILED_RULES = new Map<CodeBlockLanguage, RegExp>();

// Builds (and caches) a single alternation regex for a language's rules, one named
// capture group per rule so a match can be traced back to its token kind.
function compiledRule(language: CodeBlockLanguage): RegExp {
  const cached = COMPILED_RULES.get(language);
  if (cached) return cached;
  const rules = RULES[language];
  const source = rules
    .map((rule, index) => `(?<g${String(index)}>${rule.pattern})`)
    .join('|');
  const regex = new RegExp(source, 'g');
  COMPILED_RULES.set(language, regex);
  return regex;
}

/** Splits one line of source into comment/string/keyword/number/plain runs for a
 * language the gallery covers (ts, tsx, css, json). Pure and line-scoped — a `/* *\/`
 * block comment spanning multiple lines is only recognized within a single line. */
export function tokenizeLine(
  line: string,
  language: CodeBlockLanguage
): CodeToken[] {
  if (line === '') return [];

  const rules = RULES[language];
  const regex = compiledRule(language);
  regex.lastIndex = 0;

  const tokens: CodeToken[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    if (match.index > cursor) {
      tokens.push({ text: line.slice(cursor, match.index), kind: 'plain' });
    }
    const groupIndex = Object.entries(match.groups ?? {}).findIndex(
      ([, value]) => value !== undefined
    );
    const kind =
      groupIndex === -1 ? 'plain' : (rules[groupIndex]?.kind ?? 'plain');
    tokens.push({ text: match[0], kind });
    cursor = match.index + match[0].length;
  }
  if (cursor < line.length) {
    tokens.push({ text: line.slice(cursor), kind: 'plain' });
  }
  return tokens;
}

/** Reduces a `useStreamedText` reveal to whole completed lines only — a line that's
 * still mid-type stays hidden rather than flickering partial text, so the block reads
 * as lines arriving one at a time. Once `shown` catches up to `code`, every line
 * (including a trailing one with no newline) is returned. */
export function revealedLines(code: string, shown: string): string[] {
  if (shown.length >= code.length) return code.split('\n');
  // The last split segment is always either a still-typing partial line or the
  // not-yet-started next line (when `shown` ends exactly on a newline) — either way
  // it isn't a completed line yet, so drop it.
  const lines = shown.split('\n');
  lines.pop();
  return lines;
}

const TOKEN_CLASS: Record<CodeTokenKind, string> = {
  comment: 'text-muted-foreground',
  string: 'text-green',
  keyword: 'text-primary',
  number: 'text-[var(--violet)]',
  plain: '',
};

// How long the "Copied" check stays swapped in before the button reverts to "Copy".
const COPIED_RESET_MS = 1500;

/** Framed source snippet: mono filename + language label header with a copy button,
 * and a horizontally-scrollable `font-mono` body. `streaming` reveals `code` one
 * completed line at a time (via `useStreamedText`), each line fading in on arrival —
 * skipped entirely under reduced motion. Matches the showcase's "Code Block" primitive. */
export function CodeBlock({
  code,
  language,
  filename,
  streaming = false,
  onCopy,
}: CodeBlockProps) {
  const shown = useStreamedText(code, { enabled: streaming });
  const lines = streaming ? revealedLines(code, shown) : code.split('\n');

  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  function handleCopy() {
    void navigator.clipboard?.writeText(code).catch(() => undefined);
    onCopy?.(code);
    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => {
      setCopied(false);
    }, COPIED_RESET_MS);
  }

  const lineClassName = streaming
    ? 'opacity-100 transition-opacity duration-300 ease-out-expo starting:opacity-0 motion-reduce:transition-none'
    : undefined;

  return (
    <div className="bg-surface-inset rounded-card shadow-hairline w-full overflow-hidden">
      <div className="border-border flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="flex min-w-0 items-baseline gap-2">
          {filename !== undefined && (
            <span className="text-foreground truncate font-mono text-[12px] font-medium">
              {filename}
            </span>
          )}
          <span className="text-muted-foreground shrink-0 text-[11.5px]">
            {LANGUAGE_LABEL[language]}
          </span>
        </span>
        <button
          type="button"
          aria-label={copied ? 'Copied' : 'Copy code'}
          onClick={handleCopy}
          className="text-muted-foreground hover:bg-surface-hover-strong hover:text-foreground ease-out-expo flex h-6 shrink-0 items-center gap-1 rounded-[6px] px-1.5 text-[11.5px] font-medium transition-colors duration-100"
        >
          {copied ? (
            <CheckIcon aria-hidden className="text-green size-3" />
          ) : (
            <CopyIcon aria-hidden className="size-3" />
          )}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2.5">
        <code className="text-foreground block font-mono text-sm whitespace-pre">
          {lines.map((line, index) => (
            <div key={index} className={lineClassName}>
              {line === ''
                ? ' '
                : tokenizeLine(line, language).map((token, tokenIndex) => (
                    <span key={tokenIndex} className={TOKEN_CLASS[token.kind]}>
                      {token.text}
                    </span>
                  ))}
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}
