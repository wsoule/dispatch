import type { ReactNode } from 'react';

import ThemeToggle from '../components/theme-toggle';
import { initials } from '../edit/shared';
import { Link } from '../lib/link';
import styles from './signed-out-frame.module.css';
import type { SignedOutFrameProps } from './types';

/* The frame for signed-out pages (sign in, errors), Gr8r's auth frame: the
   warm page background with a plain top row — the brand tile and product
   name, an optional quiet badge ("Demo") inside the brand link so the
   link keeps main's name ("Milestone Planner Demo"), the theme toggle —
   above the content column. */
export default function SignedOutFrame({
  appName,
  brandHref,
  label,
  themeStorageKey,
  actions,
  mainId = 'main',
  children,
}: SignedOutFrameProps): ReactNode {
  return (
    <div className={styles.frame}>
      <Link href={`#${mainId}`} className="skipLink">
        Skip to content
      </Link>
      <header className={styles.bar}>
        <Link href={brandHref} className={styles.brand}>
          <span className={styles.logo} aria-hidden="true">
            {initials(appName)}
          </span>
          <span className={styles.brandName}>{appName}</span>
          {label !== undefined && label !== '' ? (
            <span className={styles.brandLabel}>{label}</span>
          ) : null}
        </Link>
        <div className={styles.end}>
          {actions}
          {themeStorageKey !== undefined ? (
            <ThemeToggle storageKey={themeStorageKey} />
          ) : null}
        </div>
      </header>
      <main id={mainId} tabIndex={-1} className={styles.main}>
        {children}
      </main>
    </div>
  );
}
