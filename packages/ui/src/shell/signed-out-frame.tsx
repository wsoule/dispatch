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
   above the content column, and, when given, a quiet row of footer links
   (privacy · terms · contact) under it. The dots between the links are
   drawn by CSS and hidden from assistive technology; the links sit in a
   list inside a named navigation landmark. */
export default function SignedOutFrame({
  appName,
  brandHref,
  label,
  themeStorageKey,
  actions,
  footerLinks,
  footerLabel = 'About this site',
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
      {footerLinks !== undefined && footerLinks.length > 0 ? (
        <footer className={styles.footer}>
          <nav aria-label={footerLabel}>
            <ul className={styles.footerLinks}>
              {footerLinks.map((link) => (
                <li key={link.href} className={styles.footerItem}>
                  <Link href={link.href} className={styles.footerLink}>
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </footer>
      ) : null}
    </div>
  );
}
