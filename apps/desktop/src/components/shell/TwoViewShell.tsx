import { Activity, type ReactNode } from 'react';

import type { MainView } from '../../lib/twoViews';
import { ErrorBoundary } from './ErrorBoundary';
import { TwoViewTopBar, type TwoViewTopBarProps } from './TwoViewTopBar';

export interface TwoViewShellProps {
  topBar: TwoViewTopBarProps;
  view: MainView;
  /** A resolution, sign-in or get-started screen; it replaces both views. */
  gate: ReactNode | null;
  overseer: ReactNode;
  tasks: ReactNode;
  /** A drawer over either view; it never changes the view underneath. */
  peek: ReactNode;
}

/** Two views: the top bar, then Overseer and Tasks both mounted so each keeps its place. */
export function TwoViewShell({
  topBar,
  view,
  gate,
  overseer,
  tasks,
  peek,
}: TwoViewShellProps) {
  return (
    <div
      data-testid="two-views-shell"
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <TwoViewTopBar {...topBar} />
      <main className="bg-background border-border-panel shadow-panel rounded-popover relative mx-2 mb-2 min-h-0 flex-1 overflow-hidden border-[0.5px]">
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
            </>
          )}
        </ErrorBoundary>
      </main>
    </div>
  );
}
