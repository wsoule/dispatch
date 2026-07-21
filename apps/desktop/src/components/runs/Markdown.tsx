import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

import { cn } from '@/lib/utils';

// Renders agent/message text as GitHub-flavored markdown with syntax-highlighted code fences,
// so a run's Session transcript reads like Claude Code's own output (headings, lists, tables,
// **bold**, `inline code`, and highlighted ```code blocks```) instead of the flat pre-wrapped
// text it was before. Element styling lives in styles/markdown.css under the `.dispatch-md`
// scope; only the two `code`/`pre` renderers below need JSX (to tell inline code from a fenced
// block — react-markdown v9 no longer passes an `inline` flag, so we infer it from whether
// rehype-highlight tagged the node with a `language-*`/`hljs` class, which it only does for
// fenced blocks).
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
              return <code className={codeClassName}>{children}</code>;
            }
            return (
              <code className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="bg-muted/60 border-border/60 my-2 overflow-x-auto rounded-md border p-3 font-mono text-[12.5px] leading-snug">
              {children}
            </pre>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
