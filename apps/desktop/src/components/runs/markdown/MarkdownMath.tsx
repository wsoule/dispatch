import { useEffect, useReducer } from 'react';

type Katex = typeof import('katex').default;

const CACHE_LIMIT = 1000;

let katexLoad: Promise<Katex | null> | null = null;
// "" records TeX KaTeX couldn't parse, which then stays readable as its source.
const typeset = new Map<string, string>();

// KaTeX and its stylesheet load on the first formula, not with the app.
function loadKatex(): Promise<Katex | null> {
  katexLoad ??= Promise.all([
    import('katex'),
    import('katex/dist/katex.min.css'),
  ]).then(
    ([katex]) => katex.default,
    () => null
  );
  return katexLoad;
}

function cacheKey(tex: string, display: boolean): string {
  return `${display ? 'display' : 'inline'}:${tex}`;
}

async function typesetMath(tex: string, display: boolean): Promise<void> {
  const katex = await loadKatex();
  let html = '';
  try {
    html =
      katex?.renderToString(tex, {
        displayMode: display,
        output: 'htmlAndMathml',
        throwOnError: true,
        // No \href, \url or \htmlClass: nothing that emits links or active HTML.
        trust: false,
        strict: 'ignore',
        maxSize: 20,
        maxExpand: 1000,
      }) ?? '';
  } catch {
    html = '';
  }
  if (typeset.size >= CACHE_LIMIT) {
    const oldest = typeset.keys().next().value;
    if (oldest !== undefined) typeset.delete(oldest);
  }
  typeset.set(cacheKey(tex, display), html);
}

/**
 * One `$$…$$` formula from remark-math, typeset with KaTeX. Shows its TeX until KaTeX
 * loads, and keeps showing it when the TeX doesn't parse (such as mid-stream). A wide
 * display equation scrolls on its own instead of widening the message.
 */
export function MarkdownMath({
  tex,
  display,
}: {
  tex: string;
  display: boolean;
}) {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const source = tex.trim();
  const html = typeset.get(cacheKey(source, display));
  const pending = html === undefined;
  useEffect(() => {
    if (!pending) return;
    let live = true;
    void typesetMath(source, display).then(() => {
      if (live) rerender();
    });
    return () => {
      live = false;
    };
  }, [source, display, pending]);

  const fallback = display ? `$$\n${source}\n$$` : `$$${source}$$`;
  const Tag = display ? 'div' : 'span';
  return (
    <Tag
      data-slot="markdown-math"
      data-display={display || undefined}
      role="math"
      aria-label={source}
      className={
        display
          ? 'my-[0.65em] block overflow-x-auto overflow-y-hidden py-1'
          : 'inline-block max-w-full overflow-x-auto align-middle'
      }
    >
      {html ? (
        <span dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <span className="font-mono text-[0.9em] whitespace-pre-wrap">
          {fallback}
        </span>
      )}
    </Tag>
  );
}
