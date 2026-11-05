import { Tooltip } from '@dispatch/ui';
import type { ReactNode } from 'react';

import { GLOSSARY, type GlossaryKey } from '../../lib/glossary';
import styles from './GlossaryTerm.module.css';

/** A first-screen word with a dotted underline; hovering it, or reaching
    it with the keyboard, shows its definition in the library Tooltip (no
    provider). The word itself is the focusable element the tooltip
    describes through aria-describedby. */
export function GlossaryTerm({
  term,
  children,
  defaultOpen,
}: {
  term: GlossaryKey;
  children: ReactNode;
  /** Shows the hint from the first render; tests use it, since hover
      timing is not reliable in happy-dom. */
  defaultOpen?: boolean;
}) {
  return (
    <Tooltip content={GLOSSARY[term]} defaultOpen={defaultOpen}>
      <span tabIndex={0} data-glossary={term} className={styles.term}>
        {children}
      </span>
    </Tooltip>
  );
}
