import { Disclosure } from '@dispatch/ui';
import type { ReactNode } from 'react';

import { cx } from './cx';
import styles from './RawText.module.css';

/** Raw output (an error message, a log tail, an item's JSON) in a small scrolling mono well,
    wrapped so a long line never widens its container. */
export function RawText({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <pre className={cx(styles.raw, className)}>{children}</pre>;
}

/** Raw output hidden behind a quiet "Details" button: errors lead with a sentence, and the
    log is there for whoever asks. */
export function RawDetails({
  text,
  summary = 'Details',
}: {
  text: string;
  summary?: ReactNode;
}) {
  return (
    <Disclosure variant="button" summary={summary}>
      <RawText className={styles.details}>{text}</RawText>
    </Disclosure>
  );
}
