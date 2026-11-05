'use client';

import { Check, Copy } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { COPIED_MS, selectContents, writeClipboard } from '../lib/clipboard';
import { dataAttributes } from '../lib/data-attributes';
import { Button } from './button';
import { cx } from './class-names';
import styles from './copy-value.module.css';
import type { CopyValueProps } from './types';

type CopyState = 'idle' | 'copied' | 'failed';

/* A value to copy (a token, a pairing code, an invite link): the value in
   a recessed code well, Geist Mono by default, then a small secondary
   Copy button named "Copy {label}". A copy says Copied with a tick for
   COPIED_MS; when the clipboard is missing or refused it says "Select
   it" and selects the value, which stays on screen, so Ctrl/Cmd + C still
   works. Either way the button returns to Copy after COPIED_MS, and a
   polite live region says what happened (the button's name stays the
   same). The host's data-* hooks land on the code element, whose text is
   exactly the value. */
export function CopyValue(props: CopyValueProps): ReactNode {
  const { value, label, mono = true, truncate = false } = props;
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const codeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    const ok = await writeClipboard(value);
    // The clipboard can settle after the control has gone.
    if (!mounted.current) return;
    if (timer.current !== null) clearTimeout(timer.current);
    setState(ok ? 'copied' : 'failed');
    timer.current = setTimeout(() => setState('idle'), COPIED_MS);
    if (!ok) selectContents(codeRef.current);
  }

  const word =
    state === 'copied' ? 'Copied' : state === 'failed' ? 'Select it' : 'Copy';
  const announcement =
    state === 'copied'
      ? `Copied the ${label}.`
      : state === 'failed'
        ? `Could not copy. The ${label} is selected: copy it by hand.`
        : '';

  return (
    <div className={cx(styles.copy, truncate ? styles.truncate : undefined)}>
      <code
        {...dataAttributes(props)}
        ref={codeRef}
        className={cx(styles.value, mono ? styles.mono : undefined)}
        title={truncate ? value : undefined}
      >
        {value}
      </code>
      <Button
        size="sm"
        aria-label={`Copy ${label}`}
        data-state={state}
        icon={
          state === 'copied' ? (
            <Check size={14} strokeWidth={1.8} />
          ) : (
            <Copy size={14} strokeWidth={1.8} />
          )
        }
        onClick={() => void copy()}
      >
        {word}
      </Button>
      <span className="srOnly" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
