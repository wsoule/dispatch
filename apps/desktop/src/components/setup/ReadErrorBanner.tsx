import { AlertStrip } from '@dispatch/ui';

import styles from './setup.module.css';

/** The app-wide strip while the project's task list fails to load. Every view
    falls back to empty lists, so without it a broken connection reads as an
    empty project ("No tasks yet"). `plain`: the shell's banner slot draws the
    strip. */
export function ReadErrorBanner({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}) {
  return (
    <div role="alert" className={styles.banner}>
      <AlertStrip
        tone="danger"
        plain
        label="Can't load this project"
        action={{ label: 'Retry', onClick: onRetry }}
      >
        What you see may be empty or out of date. {error}
      </AlertStrip>
    </div>
  );
}
