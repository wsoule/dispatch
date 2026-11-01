import type { ReactNode } from 'react';
import { memo, useMemo } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

import { LinkedImage, MarkdownLink } from './LinkedImage';
import {
  MarkdownCodeFence,
  MarkdownStreamingContext,
} from './markdown/MarkdownCodeFence';
import { MarkdownMath } from './markdown/MarkdownMath';
import { cn } from '@/lib/utils';

// The slug remark tags a fenced block's `<code>` with (`language-xxx`), lowercased, or
// undefined for a bare fence.
function fenceLanguage(codeClassName: string | undefined): string | undefined {
  const match = /language-([\w+#.-]+)/.exec(codeClassName ?? '');
  return match?.[1]?.toLowerCase();
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
// one space-joined string for `fenceLanguage`.
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

// The renderers that never change, kept at module scope so their identity holds across
// renders: react-markdown treats a new function as a new component type, and would remount
// every link, inline code span and code block of the message on each render.
const STATIC_COMPONENTS = {
  a: ({ children, href }) => (
    <MarkdownLink href={href}>{children}</MarkdownLink>
  ),
  // remark-math hands inline `$$…$$` over as `<code class="math-inline">`.
  code: ({ children, node }) =>
    hastClassName(node as HastLike | undefined)?.includes('math-inline') ? (
      <MarkdownMath tex={hastText(node)} display={false} />
    ) : (
      <code className="rounded-[4px] bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)] px-[0.35em] py-[0.1em] font-mono text-[0.85em]">
        {children}
      </code>
    ),
  // Every `<pre>` react-markdown emits wraps a fenced (or indented) code block, or a
  // display formula from remark-math (`language-math`). The source text and language
  // come from the hast `node`, not the rendered `children` — see `hastText`.
  pre: ({ node }) => {
    const codeElement = preCodeChild(node);
    const code = hastText(codeElement ?? node).replace(/\n$/, '');
    const language = fenceLanguage(hastClassName(codeElement));
    if (language === 'math') return <MarkdownMath tex={code} display />;
    return <MarkdownCodeFence code={code} language={language} />;
  },
  // A wide table scrolls inside the message instead of widening it.
  table: ({ children }) => (
    <div className="dispatch-md-table">
      <table>{children}</table>
    </div>
  ),
} satisfies Components;

// Only `$$…$$` is math: single dollars are too common in agent prose ("$5 to $10").
const REMARK_PLUGINS = [
  remarkGfm,
  [remarkMath, { singleDollarTextMath: false }],
] satisfies NonNullable<Parameters<typeof ReactMarkdown>[0]['remarkPlugins']>;

// Renders agent/message text as GitHub-flavored markdown, so a run's Session transcript reads
// like Claude Code's own output (headings, lists, tables, **bold**, `inline code`, and fenced
// ```code blocks```) instead of the flat pre-wrapped text it was before, with T3 Code's
// extras: fences colored by Shiki, ```mermaid fences drawn as diagrams, `$$…$$` math typeset
// by KaTeX, and wide tables scrolling in place (see ./markdown/). Element styling lives in
// styles/markdown.css under the `.dispatch-md` scope. Fenced blocks are intercepted at the
// `pre` level (react-markdown only emits `<pre>` around a code block), where the raw source
// is lifted straight off the hast node.
//
// `variant: 'prose'` is the task page's long-form measure (Linear's 15px/450 on a 24px line,
// headings held at 15px/600 so a description never shouts over the title); the default
// inherits the caller's size for transcripts, chat and cards.
//
// Memoized: a chat re-renders on every streamed delta, and parsing every settled message's
// markdown again each time stalls the window in a long conversation. Only a message whose
// props changed renders.
export const Markdown = memo(function Markdown({
  content,
  className,
  variant = 'inline',
  urlTransform,
  img,
  streaming = false,
}: {
  content: string;
  /** The reply is still arriving: new blocks fade in (see `.dispatch-md[data-streaming]`). */
  streaming?: boolean;
  className?: string;
  variant?: 'inline' | 'prose';
  /** Replaces react-markdown's URL filter (the docs preview keeps `asset:`). */
  urlTransform?: (url: string, key: string) => string;
  /** Renders images; the docs preview resolves `asset:` through the API. */
  img?: (props: { src?: string; alt?: string }) => ReactNode;
}) {
  // One component per `img`, so a rerender keeps each image mounted (and fetched once).
  // With no `img`, an image is a link: agent-written markdown never loads one.
  const components = useMemo<Components>(() => {
    const render = img ?? LinkedImage;
    return {
      ...STATIC_COMPONENTS,
      img: ({ src, alt }) =>
        render({ src: typeof src === 'string' ? src : undefined, alt }),
    };
  }, [img]);
  return (
    <div
      data-slot="markdown"
      data-variant={variant}
      data-streaming={streaming || undefined}
      className={cn(
        'dispatch-md',
        variant === 'prose' && 'dispatch-md-prose',
        className
      )}
    >
      <MarkdownStreamingContext value={streaming}>
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          {...(urlTransform === undefined ? {} : { urlTransform })}
          components={components}
        >
          {content}
        </ReactMarkdown>
      </MarkdownStreamingContext>
    </div>
  );
});
