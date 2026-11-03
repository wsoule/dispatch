import {
  AppShell,
  type ShellSection,
  type ShellUser,
  type ShellWorkspaceSwitcher,
  type UiLinkProps,
  UiLinkProvider,
  useModKeyLabel,
} from '@dispatch/ui';
import {
  Activity,
  createContext,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import {
  buildCrumbs,
  buildSettingsLink,
  buildShellNav,
  buildShellTabs,
  type OverseerBadge,
} from '../../adapters/shell';
import { isShown } from '../../hooks/useGlobalKeyboard';
import type { AdminItem } from '../../lib/adminItems';
import type { MainView, NavAction, NavSettingsPage } from '../../lib/appNav';
import { parseHref } from '../../lib/routes';
import { hrefFor, type ShellDestination } from '../../lib/shellRoutes';
import { THEME_STORAGE_KEY } from '../../lib/theme';
import { usePeople } from '../people/PeopleContext';
import styles from './DispatchShell.module.css';
import { ErrorBoundary } from './ErrorBoundary';
import { GATE_TRAFFIC_LIGHT_INSET_PX } from './GateFrame';

/** Where the collapsed rail is remembered; the `[` handler in App shares it. */
export const SHELL_STORAGE_KEY = 'dispatch:shell-collapsed';

// The id AppShell gives its <main>, which the module stylesheet sizes to the window.
const MAIN_ID = 'dispatch-main';

/** What the window's native chrome asks of the shell. */
interface WindowChrome {
  /** A Tauri window: dragging the brand row or the topbar moves it. */
  dragRegion: boolean;
  /** macOS's traffic lights float over the top-left corner (not in fullscreen). */
  trafficLightInset: boolean;
}

export interface DispatchShellProps {
  /** The active project's name: the brand row's second line and the first crumb. */
  projectName: string | null;
  view: MainView;
  destination: ShellDestination;
  /** The last crumb, the page open under the destination: the open task's title
   * under Issues, or "Live" under Runs (`currentShellPageTitle`). */
  taskTitle: string | null;
  overseerBadge: OverseerBadge;
  needsYou: number;
  threadsUnread: number;
  adminItems: readonly AdminItem[];
  projects: ShellSection;
  /** This person's tier on the daemon, the badge beside their name. */
  tier: string | null;
  /** Set on a team-local page: who is signed in, and how to stop. */
  teamSession?: { handle: string; onSignOut: () => void };
  windowChrome?: WindowChrome;
  /** Every link in the shell (a sidebar row, a project row, a crumb, the
   * Projects section's "All") dispatches the actions its href parses to
   * (lib/routes.ts), one at a time, in order. */
  onNavigate: (action: NavAction) => void;
  /** The topbar's search trigger: the command palette. */
  onSearch: () => void;
  /** Controls right of the search trigger (who is here). */
  topbarActions?: ReactNode;
  /** Makes the brand row the project switcher (projectWorkspaceSwitcher in
   *  projectWorkspaces.ts): a menu of the projects plus "Add project…".
   *  Without it the brand row links to the Overseer. */
  workspaceSwitcher?: ShellWorkspaceSwitcher;
  /** An app-wide notice strip under the topbar (setup problems). */
  banner?: ReactNode;
  /** A screen that replaces both views (the resolution error, "Loading
   * project…"). Settings still opens over it (the gate stays mounted,
   * hidden). App's setup gates sit in GateFrame instead, outside the shell:
   * over one, App mounts the shell for Settings alone and passes `false`
   * here, a gate that draws nothing but keeps the views unmounted. */
  gate: ReactNode | null;
  overseer: ReactNode;
  tasks: ReactNode;
  /** A drawer over either view; it never changes the view underneath.
   * Hidden, still mounted, while Settings shows, so closing Settings brings
   * it back as it was (Escape closes Settings before the peek). */
  peek: ReactNode;
  /** The first-task guide card, floating over either view; hidden under a
   * gate, a peek or Settings. */
  guide?: ReactNode;
  /** The Settings page, set while `NavState.settings` is: it takes the main
   * column (over a gate too), and both views stay mounted, hidden, beneath
   * it. Null or undefined while Settings is closed. */
  settings?: ReactNode;
  /** The Settings page showing, for the last crumb ("Settings › Agents"). */
  settingsPage?: NavSettingsPage | null;
}

// Main width below which the expanded guide card (320px) would sit over centered content.
const NARROW_MAIN_PX = 1024;

const NarrowMainContext = createContext(false);

/** Whether the shell's main area is too narrow for the expanded guide card beside its content. */
export function useNarrowMain(): boolean {
  return useContext(NarrowMainContext);
}

// Tracks the content area's width with a ResizeObserver and reports whether it is narrow.
function useIsNarrow(ref: React.RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = () => setNarrow(el.clientWidth < NARROW_MAIN_PX);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return narrow;
}

/** Handles a shell link's href in the app; true when it did, so the click is kept. */
type FollowHref = (href: string) => boolean;

const FollowContext = createContext<FollowHref>(() => false);

// The link AppShell renders: a real anchor (a middle or modified click is left
// to the browser, which opens the hash as it would any link; in one window that
// is a hashchange `useHashRoute` applies), while a plain left click stays in the
// app and dispatches the route's actions. Hrefs the app does not know (the skip
// link) fall through.
function DispatchLink({ href, onClick, children, ...rest }: UiLinkProps) {
  const follow = useContext(FollowContext);
  return (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return;
        }
        if (follow(href)) event.preventDefault();
      }}
    >
      {children}
    </a>
  );
}

/** The person's name as the sidebar shows it: the registry's, else the handle. */
function displayName(
  me: string,
  personFor: (ref: string) => { name: string } | undefined
): string {
  return personFor(me)?.name ?? me.replace(/^human:/, '');
}

/** True when focus rests nowhere useful: on <body>, or on an element that is
 * gone or hidden (inside a view an Activity boundary just hid). */
function focusLost(): boolean {
  const active = document.activeElement;
  return (
    active === null ||
    active === document.body ||
    active === document.documentElement ||
    !(active instanceof HTMLElement) ||
    !isShown(active)
  );
}

/**
 * Moves focus into Settings when it opens and back out when it closes, the
 * part of the old Settings dialog's focus handling a main-column page still
 * needs. Opening hides the view that held focus, so focus would drop to
 * <body>: it goes to the Settings region instead (named "Settings" for a
 * screen reader), unless it is already inside. A page switch that drops focus
 * (the focused link unmounted) brings it back to the region. Closing unmounts
 * the page with focus inside it: focus returns to the element last focused
 * outside Settings when that is shown again, else to the main column. Focus
 * a close left somewhere useful (a sidebar link, a peek) stays there.
 */
function useSettingsFocus(
  slotRef: React.RefObject<HTMLDivElement | null>,
  open: boolean,
  page: NavSettingsPage | null
): void {
  // The element focused last outside Settings, recorded on every focus move.
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  useEffect(() => {
    function record(event: FocusEvent) {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (slotRef.current?.contains(target) === true) return;
      openerRef.current = target;
    }
    document.addEventListener('focusin', record, true);
    return () => document.removeEventListener('focusin', record, true);
  }, [slotRef]);
  // A passive effect on purpose: it runs after the passive cleanups of the
  // subtree Settings just hid, among them a peek's dialog focus handing focus
  // back to its own opener, so Settings takes focus last.
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;
    if (open) {
      const slot = slotRef.current;
      if (slot === null || slot.contains(document.activeElement)) return;
      if (!wasOpen || focusLost()) slot.focus({ preventScroll: true });
      return;
    }
    if (!wasOpen || !focusLost()) return;
    const opener = openerRef.current;
    if (opener !== null && isShown(opener)) {
      opener.focus({ preventScroll: true });
    } else {
      document.getElementById(MAIN_ID)?.focus({ preventScroll: true });
    }
  }, [slotRef, open, page]);
}

// How many scrolled boxes the shell remembers before it prunes removed ones.
const KEPT_SCROLL_LIMIT = 64;

/**
 * Puts back the scroll positions that Settings' hidden views lose. A hidden
 * Activity boundary hides its subtree with display: none, and the browser
 * drops the scroll offset of a box it does not render, so a list scrolled
 * halfway down (or a peek's body) would come back at the top. The content box
 * records each scroll as it happens (scroll events do not bubble, so it
 * listens in the capture phase) and writes the positions back once Settings
 * closes and the views show again.
 */
function useScrollKeptUnderSettings(
  contentRef: React.RefObject<HTMLDivElement | null>,
  settingsRef: React.RefObject<HTMLDivElement | null>,
  open: boolean
): void {
  const positionsRef = useRef(
    new Map<Element, { top: number; left: number }>()
  );
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const box = contentRef.current;
    if (box === null) return;
    function record(event: Event) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (settingsRef.current?.contains(target) === true) return;
      const positions = positionsRef.current;
      // Rows come and go; drop the boxes React removed before the map grows.
      if (positions.size >= KEPT_SCROLL_LIMIT) {
        for (const element of positions.keys()) {
          if (!element.isConnected) positions.delete(element);
        }
      }
      positions.set(target, {
        top: target.scrollTop,
        left: target.scrollLeft,
      });
    }
    box.addEventListener('scroll', record, { capture: true, passive: true });
    return () => box.removeEventListener('scroll', record, { capture: true });
  }, [contentRef, settingsRef]);
  useLayoutEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;
    if (open || !wasOpen) return;
    for (const [element, { top, left }] of positionsRef.current) {
      if (!element.isConnected) {
        positionsRef.current.delete(element);
      } else if (isShown(element)) {
        element.scrollTop = top;
        element.scrollLeft = left;
      }
    }
  }, [open]);
}

/**
 * The desktop's frame: @dispatch/ui's AppShell (sidebar with the brand row's
 * project switcher, the destinations and the Projects section; a footer with
 * the person, the light/dark toggle (the library ThemeToggle, stored under
 * THEME_STORAGE_KEY, which the pre-paint script in vite.config.ts reads back)
 * and a team-local sign-out; topbar with crumbs, search and who is here)
 * around the Overseer and Tasks views, both mounted so each keeps its
 * place, with the peek drawer and the guide card floating over them. While
 * Settings is open it takes the main column in their place, over a gate
 * too. It is an overlay place: the views, the gate and the peek stay
 * mounted, hidden (their state, focus and scroll come back with them), and
 * Escape or any navigation returns to them. Navigation stays in App's nav
 * reducer: the sidebar reads it for the current row, and every link's href
 * is a route whose actions a plain click dispatches.
 */
export function DispatchShell({
  projectName,
  view,
  destination,
  taskTitle,
  overseerBadge,
  needsYou,
  threadsUnread,
  adminItems,
  projects,
  tier,
  teamSession,
  windowChrome,
  onNavigate,
  onSearch,
  topbarActions,
  workspaceSwitcher,
  banner,
  gate,
  overseer,
  tasks,
  peek,
  guide,
  settings,
  settingsPage = null,
}: DispatchShellProps) {
  const modLabel = useModKeyLabel();
  // Settings is an overlay place: while it shows, the views, the gate and the
  // peek stay mounted under hidden Activity boundaries (scroll, drafts and
  // state kept).
  const settingsOpen = settings !== undefined && settings !== null;
  const { me, personFor } = usePeople();
  const contentRef = useRef<HTMLDivElement>(null);
  const narrow = useIsNarrow(contentRef);
  const settingsRef = useRef<HTMLDivElement>(null);
  useSettingsFocus(settingsRef, settingsOpen, settingsPage);
  useScrollKeptUnderSettings(contentRef, settingsRef, settingsOpen);

  // The handlers change every render; the link component must not, or every
  // sidebar link would remount (and lose focus) on each app render.
  const followRef = useRef<FollowHref>(() => false);
  followRef.current = (href) => {
    const actions = parseHref(href);
    if (actions === null) return false;
    for (const action of actions) onNavigate(action);
    return true;
  };
  const follow = useCallback<FollowHref>((href) => followRef.current(href), []);

  const user: ShellUser | undefined =
    me === null
      ? undefined
      : {
          name: displayName(me, personFor),
          badge: tier === null ? undefined : titleCase(tier),
        };

  const chrome = windowChrome ?? {
    dragRegion: false,
    trafficLightInset: false,
  };
  const frameStyle = chrome.trafficLightInset
    ? ({
        '--shell-brand-inset': `${GATE_TRAFFIC_LIGHT_INSET_PX}px`,
      } as CSSProperties)
    : undefined;

  return (
    <div
      data-testid="dispatch-shell"
      className={styles.frame}
      style={frameStyle}
    >
      <FollowContext.Provider value={follow}>
        <UiLinkProvider link={DispatchLink}>
          <AppShell
            appName="Dispatch"
            workspaceName={projectName ?? undefined}
            brandHref={hrefFor('overseer')}
            workspaceSwitcher={workspaceSwitcher}
            nav={buildShellNav({
              destination,
              overseer: overseerBadge,
              needsYou,
              threadsUnread,
              modLabel,
            })}
            sections={[projects]}
            settings={buildSettingsLink({ destination, adminItems })}
            user={user}
            themeStorageKey={THEME_STORAGE_KEY}
            signOut={
              teamSession === undefined
                ? undefined
                : {
                    onSignOut: teamSession.onSignOut,
                    label: `Sign out ${teamSession.handle}`,
                  }
            }
            crumbs={buildCrumbs({
              projectName,
              destination,
              taskTitle,
              settingsPage,
            })}
            onSearch={onSearch}
            topbarActions={topbarActions}
            banner={banner}
            tabs={buildShellTabs(destination)}
            storageKey={SHELL_STORAGE_KEY}
            sidebarShortcut={false}
            chromeAttributes={
              chrome.dragRegion ? { 'data-tauri-drag-region': '' } : undefined
            }
            mainId={MAIN_ID}
          >
            <div ref={contentRef} className={styles.content}>
              <NarrowMainContext.Provider value={narrow}>
                <ErrorBoundary label="this view">
                  {gate === null || gate === undefined ? (
                    <>
                      <Activity
                        mode={
                          !settingsOpen && view === 'overseer'
                            ? 'visible'
                            : 'hidden'
                        }
                      >
                        {overseer}
                      </Activity>
                      <Activity
                        mode={
                          !settingsOpen && view === 'tasks'
                            ? 'visible'
                            : 'hidden'
                        }
                      >
                        {tasks}
                      </Activity>
                      <Activity mode={settingsOpen ? 'hidden' : 'visible'}>
                        {peek}
                      </Activity>
                      {!settingsOpen &&
                        guide !== undefined &&
                        guide !== null &&
                        peek === null && (
                          <div
                            data-testid="first-task-guide-slot"
                            className={
                              view === 'tasks'
                                ? `${styles.guideSlot} ${styles.guideSlotTasks}`
                                : styles.guideSlot
                            }
                          >
                            {guide}
                          </div>
                        )}
                    </>
                  ) : (
                    <Activity mode={settingsOpen ? 'hidden' : 'visible'}>
                      {gate}
                    </Activity>
                  )}
                  {settingsOpen && (
                    <div
                      ref={settingsRef}
                      role="region"
                      aria-label="Settings"
                      tabIndex={-1}
                      className={styles.settingsSlot}
                    >
                      <ErrorBoundary label="Settings">{settings}</ErrorBoundary>
                    </div>
                  )}
                </ErrorBoundary>
              </NarrowMainContext.Provider>
            </div>
          </AppShell>
        </UiLinkProvider>
      </FollowContext.Provider>
    </div>
  );
}

/** "operator" → "Operator", for the tier badge. */
function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
