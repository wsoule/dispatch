import {
  AppShell,
  type ShellSection,
  type ShellUser,
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
import type { AdminItem } from '../../lib/adminItems';
import type { MainView, NavAction } from '../../lib/appNav';
import { parseHref } from '../../lib/routes';
import { hrefFor, type ShellDestination } from '../../lib/shellRoutes';
import { usePeople } from '../people/PeopleContext';
import styles from './DispatchShell.module.css';
import { ErrorBoundary } from './ErrorBoundary';

/** Where the collapsed rail is remembered; the `[` handler in App shares it. */
export const SHELL_STORAGE_KEY = 'dispatch:shell-collapsed';

// The id AppShell gives its <main>, which the module stylesheet sizes to the window.
const MAIN_ID = 'dispatch-main';

// Extra left padding on the brand row under macOS's overlay title bar: the old
// top bar padded 84px instead of its usual 16px to clear the traffic lights.
const TRAFFIC_LIGHT_INSET_PX = 68;

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
  /** The title of the task open under Issues, the last crumb. */
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
  /** Controls right of the search trigger (the project menu, who is here). */
  topbarActions?: ReactNode;
  /** An app-wide notice strip under the topbar (setup problems). */
  banner?: ReactNode;
  /** A resolution, sign-in or get-started screen; it replaces both views. */
  gate: ReactNode | null;
  overseer: ReactNode;
  tasks: ReactNode;
  /** A drawer over either view; it never changes the view underneath. */
  peek: ReactNode;
  /** The first-task guide card, floating over either view; hidden under a gate or a peek. */
  guide?: ReactNode;
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

/**
 * The desktop's frame: @dispatch/ui's AppShell (sidebar with the destinations
 * and the Projects section, topbar with crumbs, search and the project menu)
 * around the two views, both mounted so each keeps its place, with the peek
 * drawer and the guide card floating over them. Navigation stays in App's nav
 * reducer: the sidebar reads it for the current row, and every link's href is
 * a route whose actions a plain click dispatches.
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
  banner,
  gate,
  overseer,
  tasks,
  peek,
  guide,
}: DispatchShellProps) {
  const modLabel = useModKeyLabel();
  const { me, personFor } = usePeople();
  const contentRef = useRef<HTMLDivElement>(null);
  const narrow = useIsNarrow(contentRef);

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
        '--shell-brand-inset': `${TRAFFIC_LIGHT_INSET_PX}px`,
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
            signOut={
              teamSession === undefined
                ? undefined
                : {
                    onSignOut: teamSession.onSignOut,
                    label: `Sign out ${teamSession.handle}`,
                  }
            }
            crumbs={buildCrumbs({ projectName, destination, taskTitle })}
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
                  {gate ?? (
                    <>
                      <Activity
                        mode={view === 'overseer' ? 'visible' : 'hidden'}
                      >
                        {overseer}
                      </Activity>
                      <Activity mode={view === 'tasks' ? 'visible' : 'hidden'}>
                        {tasks}
                      </Activity>
                      {peek}
                      {guide !== undefined &&
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
