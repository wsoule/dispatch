import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { cn } from '@/lib/utils';
import type { CodeBlockLanguage } from '@/ui/ai/code-block';
import { CodeBlock } from '@/ui/ai/code-block';

// Maps a fenced code block's language tag to one of `CodeBlock`'s four supported tokenizer
// languages. `CodeBlock` only knows ts/tsx/css/json — this is a TypeScript monorepo, so `ts` is
// a reasonable default for anything it doesn't recognize (bash, python, yaml, …): the tokenizer
// just won't color keywords it doesn't know, never throws.
const LANGUAGE_ALIASES: Record<string, CodeBlockLanguage> = {
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  typescript: 'ts',
  js: 'ts',
  mjs: 'ts',
  cjs: 'ts',
  javascript: 'ts',
  tsx: 'tsx',
  jsx: 'tsx',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'css',
  less: 'css',
};

// Reads the `language-xxx` slug remark tags a fenced block's `<code>` element with, and
// resolves it to a `CodeBlock` language.
function resolveLanguage(codeClassName: string | undefined): CodeBlockLanguage {
  const match = /language-([\w-]+)/.exec(codeClassName ?? '');
  const slug = match?.[1]?.toLowerCase();
  return (slug !== undefined && LANGUAGE_ALIASES[slug]) || 'ts';
}

// Minimal structural view of a hast node — just enough to walk a fenced block's subtree for
// its raw text and language class without depending on @types/hast (a transitive dependency
// of react-markdown, not one this app declares).
type HastLike = {
  type?: string;
  value?: unknown;
  tagName?: string;
  properties?: { className?: unknown };
  children?: unknown[];
};

// Flattens every text descendant of a hast node into one string — the fenced block's source
// exactly as authored. Extraction has to come from the hast `node` rather than the rendered
// React `children`: by the time a component renderer sees `children` they are React elements,
// and `String(children)` on those yields "[object Object]".
function hastText(node: unknown): string {
  if (node === null || typeof node !== 'object') return '';
  const el = node as HastLike;
  if (el.type === 'text' && typeof el.value === 'string') return el.value;
  if (Array.isArray(el.children)) return el.children.map(hastText).join('');
  return '';
}

// Finds the `<code>` hast element a fenced block's `<pre>` wraps.
function preCodeChild(node: unknown): HastLike | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const children = (node as HastLike).children;
  if (!Array.isArray(children)) return undefined;
  return children.find(
    (child): child is HastLike =>
      child !== null &&
      typeof child === 'object' &&
      (child as HastLike).tagName === 'code'
  );
}

// A hast element's className property can be a string or an array of strings — normalize to
// one space-joined string for `resolveLanguage`.
function hastClassName(node: HastLike | undefined): string | undefined {
  const className = node?.properties?.className;
  if (typeof className === 'string') return className;
  if (Array.isArray(className)) {
    return className
      .filter((c): c is string => typeof c === 'string')
      .join(' ');
  }
  return undefined;
}

// Renders agent/message text as GitHub-flavored markdown, so a run's Session transcript reads
// like Claude Code's own output (headings, lists, tables, **bold**, `inline code`, and fenced
// ```code blocks```) instead of the flat pre-wrapped text it was before. Element styling for
// everything but code fences lives in styles/markdown.css under the `.dispatch-md` scope; code
// fences render through the `CodeBlock` primitive in static mode (the whole block arrives at
// once — nothing here streams it in), which owns its own frame and tokenizing — no rehype
// highlighter runs, so the `code` renderer below only ever handles inline code. Fenced blocks
// are intercepted at the `pre` level instead (react-markdown only emits `<pre>` around a code
// block), where the raw source is lifted straight off the hast node.
export function Markdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div className={cn('dispatch-md', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          code: ({ children }) => (
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]">
              {children}
            </code>
          ),
          // Every `<pre>` react-markdown emits wraps a fenced (or indented) code block, so
          // the whole block is swapped for `CodeBlock` here. The source text and language
          // come from the hast `node`, not the rendered `children` — see `hastText`.
          pre: ({ node }) => {
            const codeElement = preCodeChild(node);
            const code = hastText(codeElement ?? node).replace(/\n$/, '');
            return (
              <div className="my-2">
                <CodeBlock
                  code={code}
                  language={resolveLanguage(hastClassName(codeElement))}
                />
              </div>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
