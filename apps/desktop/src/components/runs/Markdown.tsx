import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
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

// Reads the `language-xxx` slug rehype-highlight/remark tag a fenced block's `<code>` element
// with, and resolves it to a `CodeBlock` language.
function resolveLanguage(codeClassName: string | undefined): CodeBlockLanguage {
  const match = /language-([\w-]+)/.exec(codeClassName ?? '');
  const slug = match?.[1]?.toLowerCase();
  return (slug !== undefined && LANGUAGE_ALIASES[slug]) || 'ts';
}

// Renders agent/message text as GitHub-flavored markdown, so a run's Session transcript reads
// like Claude Code's own output (headings, lists, tables, **bold**, `inline code`, and fenced
// ```code blocks```) instead of the flat pre-wrapped text it was before. Element styling for
// everything but code fences lives in styles/markdown.css under the `.dispatch-md` scope; code
// fences render through the `CodeBlock` primitive in static mode (the whole block arrives at
// once — nothing here streams it in), which owns its own frame and tokenizing.  Only the
// `code`/`pre` renderers below need JSX (to tell inline code from a fenced block — react-markdown
// v9 no longer passes an `inline` flag, so we infer it from whether rehype-highlight tagged the
// node with a `language-*`/`hljs` class, which it only does for fenced blocks).
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
        rehypePlugins={[
          [rehypeHighlight, { detect: true, ignoreMissing: true }],
        ]}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          code: ({ className: codeClassName, children }) => {
            const isBlock =
              typeof codeClassName === 'string' &&
              (codeClassName.includes('language-') ||
                codeClassName.includes('hljs'));
            if (isBlock) {
              const code = String(children).replace(/\n$/, '');
              return (
                <div className="my-2">
                  <CodeBlock
                    code={code}
                    language={resolveLanguage(codeClassName)}
                  />
                </div>
              );
            }
            return (
              <code className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]">
                {children}
              </code>
            );
          },
          // `CodeBlock` supplies its own frame for a fenced block, so the `<pre>` react-markdown
          // would otherwise wrap it in is skipped entirely — its child (the `code` element
          // above) passes straight through instead.
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
