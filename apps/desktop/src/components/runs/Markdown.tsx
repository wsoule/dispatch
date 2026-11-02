import { CodeBlock, cx } from '@dispatch/ui';
import type { ReactNode } from 'react';
import { memo, useMemo } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { LinkedImage, MarkdownLink } from './LinkedImage';

// Display labels for the fence slugs agents write most, shown in CodeBlock's header. Only a
// label: CodeBlock never tokenizes or colours code. A slug missing here shows as written.
const LANGUAGE_LABELS: Record<string, string> = {
  ts: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  typescript: 'TypeScript',
  js: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  javascript: 'JavaScript',
  tsx: 'TSX',
  jsx: 'JSX',
  json: 'JSON',
  jsonc: 'JSON',
  css: 'CSS',
  scss: 'CSS',
  less: 'CSS',
};

// Reads the `language-xxx` slug remark tags a fenced block's `<code>` element with and turns
// it into CodeBlock's header label: the mapped name, else the raw slug, else none (a fence
// with no language tag shows no label).
function languageLabel(codeClassName: string | undefined): string | undefined {
  const match = /language-([\w-]+)/.exec(codeClassName ?? '');
  const slug = match?.[1]?.toLowerCase();
  if (slug === undefined || slug === '') return undefined;
  return LANGUAGE_LABELS[slug] ?? slug;
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
// one space-joined string for `languageLabel`.
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
  // Inline code only (fences are taken at `pre` below); styles/markdown.css draws it.
  code: ({ children }) => <code>{children}</code>,
  // Every `<pre>` react-markdown emits wraps a fenced (or indented) code block, so
  // the whole block is swapped for `CodeBlock` here. The source text and language
  // come from the hast `node`, not the rendered `children` — see `hastText`.
  pre: ({ node }) => {
    const codeElement = preCodeChild(node);
    const code = hastText(codeElement ?? node).replace(/\n$/, '');
    return (
      <CodeBlock
        code={code}
        language={languageLabel(hastClassName(codeElement))}
      />
    );
  },
} satisfies Components;

const REMARK_PLUGINS = [remarkGfm];

// Renders agent/message text as GitHub-flavored markdown, so a run's Session transcript reads
// like Claude Code's own output (headings, lists, tables, **bold**, `inline code`, and fenced
// ```code blocks```) instead of the flat pre-wrapped text it was before. Element styling for
// everything but code fences lives in styles/markdown.css under the `.dispatch-md` scope; code
// fences render through the library `CodeBlock` (its own frame, a language label and a Copy
// button, no syntax colour) and markdown.css only spaces them. No rehype highlighter runs, so
// the `code` renderer below only ever handles inline code. Fenced blocks
// are intercepted at the `pre` level instead (react-markdown only emits `<pre>` around a code
// block), where the raw source is lifted straight off the hast node.
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
      className={cx(
        'dispatch-md',
        variant === 'prose' && 'dispatch-md-prose',
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        {...(urlTransform === undefined ? {} : { urlTransform })}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
