import type { NavTabsGroup } from '@dispatch/ui';
import { Button, cx, NavTabs, Notice, SearchField } from '@dispatch/ui';
import { LockIcon, type LucideIcon } from 'lucide-react';
import type { ReactNode, Ref } from 'react';

import type { NavSettingsPage } from '../../lib/appNav';
import { settingsHref } from '../../lib/routes';
import styles from './SettingsLayout.module.css';

/** One rail entry: a Settings page, or a whole view hosted as one. */
export interface SettingsNavPage {
  id: NavSettingsPage;
  label: string;
  icon: LucideIcon;
}

/** A titled run of rail entries ("Project", "This machine", "Activity"). */
export interface SettingsNavGroup {
  label: string;
  pages: readonly SettingsNavPage[];
}

interface SettingsLayoutProps {
  groups: readonly SettingsNavGroup[];
  /** The page showing; its rail link is current unless a search is on. */
  page: NavSettingsPage;
  /** The rail's search text; a non-blank query swaps the page for results. */
  query: string;
  onQueryChange: (query: string) => void;
  /** A rail link was followed with a plain click. */
  onSelectPage: (page: NavSettingsPage) => void;
  /** A hosted view (Usage, Runs): the column takes the full width and the
   *  view scrolls inside itself instead of the column scrolling. */
  hosted?: boolean;
  children: ReactNode;
}

/**
 * Settings in the main column, in Better-Tracker's settings shape: a 220px
 * rail (the search over the grouped page links) beside the page, a column of
 * about 640px that scrolls on its own. At 900px and below the rail stacks
 * over the page and its links become one sideways-scrolling strip. The rail's
 * links are real hrefs (`#/settings/<page>`), so a middle click opens the
 * page in a new tab while a plain click selects it in place. Escape in the
 * search clears it and stops there; in an empty search it reaches the app,
 * which closes Settings.
 */
export function SettingsLayout({
  groups,
  page,
  query,
  onQueryChange,
  onSelectPage,
  hosted = false,
  children,
}: SettingsLayoutProps) {
  const searching = query.trim() !== '';
  const navGroups: NavTabsGroup[] = groups.map((group) => ({
    label: group.label,
    items: group.pages.map((entry) => {
      const Icon = entry.icon;
      return {
        id: entry.id,
        label: entry.label,
        href: settingsHref(entry.id),
        icon: <Icon size={16} strokeWidth={1.8} aria-hidden />,
        current: !searching && entry.id === page,
        onFollow: () => onSelectPage(entry.id),
      };
    }),
  }));
  return (
    <div data-testid="settings-panel" className={styles.root}>
      <div className={styles.rail}>
        <SearchField
          label="Search settings"
          placeholder="Search settings"
          clearLabel="Clear search"
          value={query}
          onChange={onQueryChange}
        />
        <NavTabs label="Settings" groups={navGroups} />
      </div>
      <div className={cx(styles.scroller, hosted ? styles.hosted : undefined)}>
        <div className={styles.column}>{children}</div>
      </div>
    </div>
  );
}

/** Settings with nothing to show yet (no project selected): the message alone,
 *  centred, keeping the root's test id so the place is still Settings. */
export function SettingsEmptyFrame({ children }: { children: ReactNode }) {
  return (
    <div data-testid="settings-panel" className={styles.emptyFrame}>
      {children}
    </div>
  );
}

/** A hosted view's body under its title: it fills the rest of the column and
 *  scrolls inside itself. */
export function SettingsHostedBody({ children }: { children: ReactNode }) {
  return <div className={styles.hostedBody}>{children}</div>;
}

/** Search results: every page that has a matching row, one under another. The
 *  ref is the box the view watches for rows to say "No settings match". */
export function SettingsResults({
  ref,
  children,
}: {
  ref?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div ref={ref} className={styles.results}>
      {children}
    </div>
  );
}

/** One page's matches under a link back to the page; a page with no matching
 *  row hides itself (CSS `:has`, so rows that load later still count). */
export function SettingsResultPage({
  page,
  onPick,
  children,
}: {
  page: SettingsNavPage;
  onPick: () => void;
  children: ReactNode;
}) {
  const Icon = page.icon;
  return (
    <section aria-label={page.label} className={styles.resultPage}>
      <span className={styles.resultLink}>
        <Button
          variant="quiet"
          size="sm"
          icon={<Icon aria-hidden size={14} strokeWidth={1.8} />}
          onClick={onPick}
        >
          {page.label}
        </Button>
      </span>
      {children}
    </section>
  );
}

/** The top of a page: its h1 beside the save line, then the one-line intro. */
export function SettingsPageHead({
  title,
  status,
  intro,
}: {
  title: ReactNode;
  /** The save line, on pages whose saves go to config.yml. */
  status?: ReactNode;
  intro?: string;
}) {
  return (
    <div className={styles.head}>
      <div className={styles.titleRow}>
        <h1 className={styles.title}>{title}</h1>
        {status}
      </div>
      {intro !== undefined && <p className={styles.intro}>{intro}</p>}
    </div>
  );
}

export type SettingsSaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

/** The one save line every config-backed page shares: "Saving…", "Saved", or
 *  the refusal in the danger tone's text colour (the words carry it too). */
export function SettingsSaveLine({ state }: { state: SettingsSaveState }) {
  const failed = state.kind === 'error';
  return (
    <span
      role="status"
      className={cx(styles.saveLine, failed ? 'toneText' : undefined)}
      data-tone={failed ? 'danger' : undefined}
    >
      {state.kind === 'saving' && 'Saving…'}
      {state.kind === 'saved' && 'Saved'}
      {failed && state.message}
    </span>
  );
}

/** Why this page's config is read-only for the viewer, as a note whose text is
 *  exactly the reason behind a lock mark (the same mark the locked rows carry),
 *  with the way out (a restart) after it when there is one. */
export function SettingsReadOnlyNote({
  reason,
  action,
}: {
  reason: string;
  action?: ReactNode;
}) {
  return (
    <div className={styles.readOnly}>
      <Notice role="note" tone="default">
        <span className={styles.lockLine}>
          <LockIcon
            aria-hidden
            className={styles.lockIcon}
            size={14}
            strokeWidth={1.8}
          />
          {reason}
        </span>
      </Notice>
      {action}
    </div>
  );
}
