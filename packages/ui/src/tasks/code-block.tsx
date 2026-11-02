'use client';

import { Check, Copy } from 'lucide-react';
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { COPIED_MS, selectContents, writeClipboard } from '../lib/clipboard';
import { dataAttributes } from '../lib/data-attributes';
import { Button } from './button';
import { cx } from './class-names';
import styles from './code-block.module.css';
import type { CodeBlockProps, CodeBlockToken } from './types';

type CopyState = 'idle' | 'copied' | 'failed';

// Layout effects do nothing on the server; this keeps React quiet there.
const useClientLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

/* The lines drawn for `code`: split on newlines (CRLF too), with the
   final line breaks dropped so a fence's closing newline draws no blank
   line at the end. The copy still writes `code` exactly. */
function codeLines(code: string): string[] {
  return code.replace(/(?:\r?\n)+$/, '').split(/\r?\n/);
}

/* The host's highlighted runs when they draw exactly `lines` (as many
   lines, each line's runs joining to its text), else undefined, so a
   highlight of other code (a stale one, a split that differs) never draws
   text the block does not hold. */
function matchingTokens(
  tokens: CodeBlockProps['tokens'],
  lines: readonly string[]
): ReadonlyArray<ReadonlyArray<CodeBlockToken>> | undefined {
  if (tokens === undefined || tokens.length !== lines.length) return undefined;
  const matches = tokens.every(
    (runs, index) => runs.map((run) => run.content).join('') === lines[index]
  );
  return matches ? tokens : undefined;
}

/* Whether the body scrolls (a long line it does not wrap, or more lines
   than maxHeight holds): then it takes a tab stop, so a keyboard can
   scroll it too (WebKit gives a scroller none of its own). Measured after
   layout, again whenever the content or the caps change, and on resize
   where ResizeObserver exists, and when the body comes back after the
   host's `children` stood in for it. Always false on the server. */
function useScrollable(
  ref: RefObject<HTMLElement | null>,
  code: string,
  wrap: boolean,
  maxHeight: string | undefined,
  drawn: boolean
): boolean {
  const [scrollable, setScrollable] = useState(false);
  useClientLayoutEffect(() => {
    const node = ref.current;
    if (node === null) return undefined;
    const measure = () =>
      setScrollable(
        node.scrollWidth > node.clientWidth ||
          node.scrollHeight > node.clientHeight
      );
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, code, wrap, maxHeight, drawn]);
  return scrollable;
}

/* Code or machine output (a Markdown fence, a tool call's JSON) as a
   <pre><code> in Geist Mono on a recessed --sunken well. Each line is a
   block span (an empty one holds a space, so a blank line keeps its
   height); long lines scroll sideways unless `wrap`, and `maxHeight` caps
   the body, which then scrolls inside. `language` is only a label: no
   tokenizer and no colour of its own: a host's highlighter colours it
   through `tokens`, runs carrying the custom properties the host's sheet
   reads. A header row shows the filename (Geist Mono), the language, the
   host's `actions` and the quiet Copy button, and is left out when none of
   them is shown. `children` draws in place of the code (a diagram drawn
   from it). Copy writes `code` and reads
   Copied with a tick for COPIED_MS; when the clipboard is missing or
   refused it reads "Couldn't copy" for as long and selects the code so
   Ctrl/Cmd + C still works. A polite live region says what happened. A
   body that scrolls takes a tab stop and is a region named by the
   filename, else "<language> code", else "Code". The host's data-* hooks
   land on the root, beside data-slot="code-block". */
export function CodeBlock(props: CodeBlockProps): ReactNode {
  const {
    code,
    language,
    filename,
    copy = true,
    copyLabel = 'Copy code',
    maxHeight,
    wrap = false,
    tokens,
    actions,
    children,
    className,
  } = props;
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const preRef = useRef<HTMLPreElement>(null);
  const codeRef = useRef<HTMLElement>(null);
  const cap = typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight;
  const scrollable = useScrollable(
    preRef,
    code,
    wrap,
    cap,
    children === undefined
  );
  const lines = codeLines(code);
  const runs = matchingTokens(tokens, lines);
  const hasActions = actions !== undefined && actions !== null;
  const hasFilename = filename !== undefined && filename !== '';
  const hasLanguage = language !== undefined && language !== '';
  // The scrolling body's name, so its tab stop is never an unnamed one:
  // the filename, else "<language> code", else "Code".
  const regionLabel = hasFilename
    ? filename
    : hasLanguage
      ? `${language} code`
      : 'Code';

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  async function copyCode() {
    const ok = await writeClipboard(code);
    // The clipboard can settle after the block has gone.
    if (!mounted.current) return;
    if (timer.current !== null) clearTimeout(timer.current);
    setState(ok ? 'copied' : 'failed');
    timer.current = setTimeout(() => setState('idle'), COPIED_MS);
    if (!ok) selectContents(codeRef.current);
  }

  const word =
    state === 'copied'
      ? 'Copied'
      : state === 'failed'
        ? "Couldn't copy"
        : 'Copy';
  const announcement =
    state === 'copied'
      ? 'Copied'
      : state === 'failed'
        ? "Couldn't copy. The code is selected: copy it by hand."
        : '';
  const body: CSSProperties | undefined =
    cap === undefined ? undefined : { maxHeight: cap };

  return (
    <div
      {...dataAttributes(props)}
      data-slot="code-block"
      className={cx(styles.root, className)}
      data-wrap={wrap ? 'true' : undefined}
    >
      {hasFilename || hasLanguage || hasActions || copy ? (
        <div className={styles.header}>
          {hasFilename ? (
            <span className={styles.filename} title={filename}>
              {filename}
            </span>
          ) : null}
          {hasLanguage ? (
            <span className={styles.language}>{language}</span>
          ) : null}
          {hasActions ? (
            <span className={styles.actions}>{actions}</span>
          ) : null}
          {copy ? (
            <Button
              variant="quiet"
              size="sm"
              className={styles.copy}
              aria-label={state === 'idle' ? copyLabel : word}
              data-state={state}
              icon={
                state === 'copied' ? (
                  <Check size={14} strokeWidth={1.8} aria-hidden="true" />
                ) : (
                  <Copy size={14} strokeWidth={1.8} aria-hidden="true" />
                )
              }
              onClick={() => void copyCode()}
            >
              {word}
            </Button>
          ) : null}
        </div>
      ) : null}
      {children !== undefined ? (
        children
      ) : (
        <pre
          ref={preRef}
          className={styles.pre}
          style={body}
          // A scroller takes a tab stop only while it scrolls; the global
          // :focus-visible ring marks it. While it does it is also a named
          // region, so a screen reader landing on it hears what it holds.
          tabIndex={scrollable ? 0 : undefined}
          role={scrollable ? 'region' : undefined}
          aria-label={scrollable ? regionLabel : undefined}
          data-scrollable={scrollable ? 'true' : undefined}
        >
          <code ref={codeRef} className={styles.code}>
            {lines.map((line, index) => {
              const end = index < lines.length - 1 ? '\n' : '';
              const lineRuns = runs?.[index];
              // A highlighted line: its runs, each a span the host's sheet
              // colours, then the break. An empty line takes the plain path
              // below, so it still holds a space.
              if (lineRuns !== undefined && line !== '') {
                return (
                  <span key={index} className={styles.line}>
                    {lineRuns.map((run, at) => (
                      <span
                        key={at}
                        data-code-token=""
                        style={run.vars as CSSProperties | undefined}
                      >
                        {run.content}
                      </span>
                    ))}
                    {end}
                  </span>
                );
              }
              // One text node per line: the line (a space when empty) and
              // its break, so the code's text and a hand copy keep the
              // newlines.
              return (
                <span key={index} className={styles.line}>
                  {`${line === '' ? ' ' : line}${end}`}
                </span>
              );
            })}
          </code>
        </pre>
      )}
      {copy ? (
        <span className="srOnly" aria-live="polite">
          {announcement}
        </span>
      ) : null}
    </div>
  );
}
