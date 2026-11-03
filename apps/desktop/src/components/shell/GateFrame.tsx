import { SignedOutFrame, type UiLinkProps, UiLinkProvider } from '@dispatch/ui';
import {
  Activity,
  createContext,
  type CSSProperties,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
} from 'react';

import { isShown } from '../../hooks/useGlobalKeyboard';
import { THEME_STORAGE_KEY } from '../../lib/theme';
import { ErrorBoundary } from './ErrorBoundary';
import styles from './GateFrame.module.css';

// Extra left padding on the top row under macOS's overlay title bar, so the brand clears the
// traffic lights (the old top bar padded 84px instead of its usual 16px). DispatchShell's
// brand row reads the same constant, so the brand does not jump when a gate gives way to
// the app.
export const GATE_TRAFFIC_LIGHT_INSET_PX = 68;

// The attribute that makes a Tauri window draggable by an element.
const DRAG_REGION = { 'data-tauri-drag-region': '' };

export interface GateFrameProps {
  /** Where the brand link points. A gate has nowhere else to go, so '#' by default, which
   *  the frame keeps from touching the address (see GateLink). */
  brandHref?: string;
  /** The id of the frame's <main>, the skip link's target. */
  mainId?: string;
  /** What the window's native chrome asks of the frame, as DispatchShell takes it. Omitted
   *  in a browser tab (the team-local sign-in). */
  windowChrome?: { dragRegion: boolean; trafficLightInset: boolean };
  /** Controls at the end of the top row (the agent gate's quiet "Settings"). */
  actions?: ReactNode;
  /** What the error fallback says could not be shown: "Dispatch couldn't display …". */
  errorLabel?: string;
  /** Hidden but still mounted (typed values, a running terminal and scroll kept) while
   *  Settings shows in the app shell over the gate. When it shows again with focus lost
   *  (Settings unmounted with focus inside), focus goes back to the gate's last focused
   *  element, else to its <main>. */
  hidden?: boolean;
  children: ReactNode;
}

// The frame's <main> id, for the skip link GateLink handles.
const MainIdContext = createContext('main');

// The frame's links. A '#…' href would rewrite the window's hash, which App's hash route
// and a pending deep link (#/task/T-1, opened before signing in) live in, so in-page hrefs
// stay in the page: the skip link focuses the <main> and the brand ('#', nowhere to go)
// does nothing. Any other href is a plain link.
function GateLink({ href, onClick, children, ...rest }: UiLinkProps) {
  const mainId = useContext(MainIdContext);
  return (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || !href.startsWith('#')) return;
        event.preventDefault();
        if (href === `#${mainId}`) document.getElementById(mainId)?.focus();
      }}
    >
      {children}
    </a>
  );
}

/**
 * Dispatch's frame for a screen shown instead of the app shell (first-launch setup, the
 * agent check, the team-local sign-in): the library SignedOutFrame with the Dispatch brand
 * and the light/dark toggle (stored under THEME_STORAGE_KEY, as the shell's is) above the
 * gate's content, so a gate has the same top row and the one <main> the shell
 * would give it, and an error boundary of its own (the shell's is not around it).
 *
 * The wrapper fills its parent and scrolls on its own, so the frame works both as the
 * whole page (TeamLocalGate) and inside App's fixed-height window frame; the top row stays
 * put while the content scrolls. In the desktop app the top row is the window's chrome:
 * `dragRegion` lets it move the window, and `trafficLightInset` sets the brand in from
 * macOS's traffic lights through the `--shell-brand-inset` property the frame reads.
 */
export function GateFrame({
  brandHref = '#',
  mainId = 'main',
  windowChrome,
  actions,
  errorLabel = 'this screen',
  hidden = false,
  children,
}: GateFrameProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  // The element focused last inside the gate, recorded on every focus move into it.
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  const wasHiddenRef = useRef(hidden);
  // A passive effect outside the Activity, so it runs after the shell over the gate has
  // unmounted (dropping focus to <body>) and the gate shows again.
  useEffect(() => {
    const wasHidden = wasHiddenRef.current;
    wasHiddenRef.current = hidden;
    if (hidden || !wasHidden) return;
    const active = document.activeElement;
    const lost =
      active === null ||
      active === document.body ||
      active === document.documentElement ||
      !isShown(active);
    if (!lost) return;
    const last = lastFocusedRef.current;
    if (
      last !== null &&
      rootRef.current?.contains(last) === true &&
      isShown(last)
    ) {
      last.focus({ preventScroll: true });
    } else {
      document.getElementById(mainId)?.focus({ preventScroll: true });
    }
  }, [hidden, mainId]);

  const style =
    windowChrome?.trafficLightInset === true
      ? ({
          '--shell-brand-inset': `${GATE_TRAFFIC_LIGHT_INSET_PX}px`,
        } as CSSProperties)
      : undefined;
  return (
    <Activity mode={hidden ? 'hidden' : 'visible'}>
      <div
        ref={rootRef}
        className={styles.root}
        style={style}
        data-testid="gate-frame"
        onFocus={(event) => {
          if (event.target instanceof HTMLElement) {
            lastFocusedRef.current = event.target;
          }
        }}
      >
        <MainIdContext.Provider value={mainId}>
          <UiLinkProvider link={GateLink}>
            <SignedOutFrame
              appName="Dispatch"
              brandHref={brandHref}
              mainId={mainId}
              actions={actions}
              themeStorageKey={THEME_STORAGE_KEY}
              chromeAttributes={
                windowChrome?.dragRegion === true ? DRAG_REGION : undefined
              }
            >
              <ErrorBoundary label={errorLabel}>{children}</ErrorBoundary>
            </SignedOutFrame>
          </UiLinkProvider>
        </MainIdContext.Provider>
      </div>
    </Activity>
  );
}
