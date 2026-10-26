'use client';

import { Check, ChevronRight, Copy, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { cx } from '../tasks/class-names';
import styles from './mermaid-source.module.css';
import type { MermaidSourceProps } from './types';

/** How long the button says Copied (a 1600ms confirmation). */
export const COPIED_MS = 1600;

type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Puts `text` on the clipboard. False when the API is missing (insecure
 * origin, old webview) or the browser refuses.
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined') return false;
    // Older webviews (and insecure origins) have no clipboard at all.
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) return false;
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * "Copy Mermaid": one panel with a secondary button that copies the
 * graph's Mermaid text and says Copied (a green tick) for 1600ms, a quiet
 * receipt, and a <details> that shows the source in mono with a line
 * gutter on a recessed well. If the clipboard refuses, the button says so
 * (a red cross) and the source opens selected, so Ctrl/Cmd + C still
 * works.
 */
export function MermaidSource({
  source,
  copyLabel = 'Copy Mermaid',
  copiedLabel = 'Copied',
  failedLabel = 'Copy failed: select below',
  sourceLabel = 'Mermaid source',
  onCopy,
  className,
}: MermaidSourceProps): ReactNode {
  const [state, setState] = useState<CopyState>('idle');
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const codeRef = useRef<HTMLElement>(null);
  const lines = source.replace(/\n+$/, '').split('\n');

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );

  async function copy() {
    const ok = await writeClipboard(source);
    if (timer.current !== null) clearTimeout(timer.current);
    setState(ok ? 'copied' : 'failed');
    timer.current = setTimeout(() => setState('idle'), COPIED_MS);
    if (!ok) {
      setOpen(true);
      // Select the code once the details has opened and rendered.
      requestAnimationFrame(() => {
        const code = codeRef.current;
        const selection = window.getSelection();
        if (code === null || selection === null) return;
        const range = document.createRange();
        range.selectNodeContents(code);
        selection.removeAllRanges();
        selection.addRange(range);
      });
    }
    onCopy?.(ok);
  }

  const wording =
    state === 'copied'
      ? copiedLabel
      : state === 'failed'
        ? failedLabel
        : copyLabel;

  return (
    <div className={cx(styles.wrap, className)}>
      <div className={styles.bar}>
        <button
          type="button"
          className={cx('button', styles.copy)}
          data-state={state}
          onClick={() => void copy()}
        >
          {state === 'copied' ? (
            <Check
              className={styles.copyIcon}
              size={14}
              strokeWidth={1.8}
              aria-hidden="true"
            />
          ) : state === 'failed' ? (
            <X
              className={styles.copyIcon}
              size={14}
              strokeWidth={1.8}
              aria-hidden="true"
            />
          ) : (
            <Copy size={14} strokeWidth={1.8} aria-hidden="true" />
          )}
          <span>{wording}</span>
        </button>
        <span className={styles.meta}>
          {lines.length} {lines.length === 1 ? 'line' : 'lines'} ·{' '}
          {lines[0]?.trim() ?? ''}
        </span>
        <span className="srOnly" role="status" aria-live="polite">
          {state === 'copied'
            ? 'Mermaid source copied to the clipboard.'
            : state === 'failed'
              ? 'Could not copy. The source is shown and selected below.'
              : ''}
        </span>
      </div>
      <details
        className={styles.details}
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className={styles.summary}>
          <ChevronRight
            className={styles.chevron}
            size={14}
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <span className={styles.summaryLabel}>{sourceLabel}</span>
        </summary>
        <pre className={styles.pre}>
          <code ref={codeRef} className={styles.code}>
            {lines.map((line, i) => (
              <span key={i} className={styles.line}>
                {line}
                {'\n'}
              </span>
            ))}
          </code>
        </pre>
      </details>
    </div>
  );
}
