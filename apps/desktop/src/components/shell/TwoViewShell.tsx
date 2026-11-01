import {
  Activity,
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import type { MainView } from '../../lib/twoViews';
import { ErrorBoundary } from './ErrorBoundary';
import { TwoViewTopBar, type TwoViewTopBarProps } from './TwoViewTopBar';
import { cn } from '@/lib/utils';

export interface TwoViewShellProps {
  topBar: TwoViewTopBarProps;
  view: MainView;
  /** A resolution, sign-in or get-started screen; it replaces both views. */
  gate: ReactNode | null;
  /** An app-wide notice strip under the top bar (setup problems). */
  banner?: ReactNode;
  overseer: ReactNode;
  tasks: ReactNode;
  /** A drawer over either view; it never changes the view underneath. */
  peek: ReactNode;
  /** The first-task guide card, floating over either view; hidden under a gate or a peek. */
  guide?: ReactNode;
}

// Main width below which the expanded guide card (w-80) would sit over centered content.
const NARROW_MAIN_PX = 1024;

const NarrowMainContext = createContext(false);

/** Whether the shell's main area is too narrow for the expanded guide card beside its content. */
export function useNarrowMain(): boolean {
  return useContext(NarrowMainContext);
}

// Tracks the main area's width with a ResizeObserver and reports whether it is narrow.
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

/** Two views: the top bar, then Overseer and Tasks both mounted so each keeps its place. */
export function TwoViewShell({
  topBar,
  view,
  gate,
  banner,
  overseer,
  tasks,
  peek,
  guide,
}: TwoViewShellProps) {
  const mainRef = useRef<HTMLElement>(null);
  const narrow = useIsNarrow(mainRef);
  return (
    <div
      data-testid="two-views-shell"
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <TwoViewTopBar {...topBar} />
      {banner}
      <main
        ref={mainRef}
        className="bg-background surface-grain border-border-panel shadow-panel rounded-popover relative mx-2 mb-2 min-h-0 flex-1 overflow-hidden border-[0.5px]"
      >
        <NarrowMainContext.Provider value={narrow}>
          <ErrorBoundary label="this view">
            {gate ?? (
              <>
                <Activity mode={view === 'overseer' ? 'visible' : 'hidden'}>
                  {overseer}
                </Activity>
                <Activity mode={view === 'tasks' ? 'visible' : 'hidden'}>
                  {tasks}
                </Activity>
                {peek}
                {guide !== undefined && guide !== null && peek === null && (
                  <div
                    data-testid="first-task-guide-slot"
                    className={cn(
                      'absolute right-3 z-30 max-w-[calc(100%-24px)]',
                      // Tasks pages pin action footers (draft Send, run review) above the dock.
                      view === 'tasks' ? 'bottom-28' : 'bottom-16'
                    )}
                  >
                    {guide}
                  </div>
                )}
              </>
            )}
          </ErrorBoundary>
        </NarrowMainContext.Provider>
      </main>
    </div>
  );
}
