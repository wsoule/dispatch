import type { TerminalInfo } from '@dispatch/client';
import { TerminalSquare } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { BackToTasks } from '../components/tasks/BackToTasks';
import { TerminalSplitView } from '../components/terminal/TerminalSplitView';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { TerminalSubscribe } from '../hooks/useTerminalOutput';
import type { LayoutNode, SplitDirection } from '../lib/terminalSplits';
import {
  attachTerminal,
  closePane,
  listPanes,
  makePane,
  neighbourPane,
  setRatio,
  splitPane,
} from '../lib/terminalSplits';
import { Button } from '@/ui/button';

/**
 * The terminal surface: shells on the repo or on a run's worktree, split any
 * number of ways.
 *
 * One WebSocket for the whole view rather than one per pane. `terminal.output`
 * events name the session, so this fans them out to whichever panes are
 * showing it — which also means two panes on the same session both update.
 */

// Ids only have to be unique within this view's layout, and a counter is
// easier to read in a DOM dump than a uuid.
let paneCounter = 0;
function nextId(prefix: string): string {
  paneCounter += 1;
  return `${prefix}-${paneCounter}`;
}

interface TerminalsViewProps {
  data: DispatchProjectData;
  /** Pre-selects a run's worktree when the view is opened from a run. */
  runId?: string | null;
  /** Two views: starts the header with "‹ tasks"; Classic leaves it out. */
  onBack?: () => void;
}

export function TerminalsView({
  data,
  runId = null,
  onBack,
}: TerminalsViewProps) {
  const { client } = data;
  const [layout, setLayout] = useState<LayoutNode>(() =>
    makePane(nextId('pane'))
  );
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null);
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Listeners keyed by session id. A ref, not state: subscribing must not
  // re-render, and the socket effect below must not re-run when a pane mounts.
  const listenersRef = useRef(new Map<string, Set<() => void>>());

  const subscribe = useCallback<TerminalSubscribe>((terminalId, onOutput) => {
    const listeners = listenersRef.current;
    const set = listeners.get(terminalId) ?? new Set<() => void>();
    set.add(onOutput);
    listeners.set(terminalId, set);
    return () => {
      set.delete(onOutput);
      if (set.size === 0) listeners.delete(terminalId);
    };
  }, []);

  const refreshSessions = useCallback(async () => {
    if (client === null) return;
    try {
      setTerminals(await client.fetchTerminals());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not list terminals');
    }
  }, [client]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    if (client === null) return;
    return client.connectEvents(() => {}, {
      onEvent: (event) => {
        if (event.type === 'terminal.output') {
          for (const listener of listenersRef.current.get(event.terminalId) ??
            []) {
            listener();
          }
          return;
        }
        // An exit changes the session row (state, exit code), which the list
        // in every pane's picker shows.
        if (event.type === 'terminal.exited') void refreshSessions();
      },
    });
  }, [client, refreshSessions]);

  const openSession = useCallback(
    async (paneId: string) => {
      if (client === null) return;
      try {
        const created = await client.createTerminal(
          runId === null ? {} : { runId }
        );
        setTerminals((prev) => [...prev, created]);
        setLayout((prev) => attachTerminal(prev, paneId, created.id));
        setFocusedPaneId(paneId);
        setError(null);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'could not open a terminal'
        );
      }
    },
    [client, runId]
  );

  const removeSession = useCallback(
    async (terminalId: string) => {
      if (client === null) return;
      try {
        await client.removeTerminal(terminalId);
      } catch {
        // Already gone — the refresh below reconciles either way.
      }
      // Detach every pane showing it, or they would sit on a 404.
      setLayout((prev) =>
        listPanes(prev).reduce<LayoutNode>(
          (tree, pane) =>
            pane.terminalId === terminalId
              ? attachTerminal(tree, pane.id, null)
              : tree,
          prev
        )
      );
      void refreshSessions();
    },
    [client, refreshSessions]
  );

  const split = useCallback((paneId: string, direction: SplitDirection) => {
    const newPaneId = nextId('pane');
    setLayout((prev) =>
      splitPane(prev, paneId, direction, newPaneId, nextId('split'))
    );
    setFocusedPaneId(newPaneId);
  }, []);

  const close = useCallback((paneId: string) => {
    setLayout((prev) => {
      const next = closePane(prev, paneId);
      // Closing the last pane leaves an empty one rather than an empty view:
      // there is nowhere else to go from here, and a blank screen with no way
      // to open a shell would be a dead end.
      if (next === null) {
        const replacement = makePane(nextId('pane'));
        setFocusedPaneId(replacement.id);
        return replacement;
      }
      setFocusedPaneId((current) =>
        current === paneId ? neighbourPane(prev, paneId) : current
      );
      return next;
    });
  }, []);

  const paneCount = useMemo(() => listPanes(layout).length, [layout]);

  if (client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <header className="flex items-center gap-2">
        {onBack && <BackToTasks onBack={onBack} />}
        <TerminalSquare className="size-4" />
        <h1 className="text-sm font-medium">Terminals</h1>
        <span className="text-xs text-[var(--color-muted-foreground)]">
          {terminals.length} session{terminals.length === 1 ? '' : 's'} ·{' '}
          {paneCount} pane
          {paneCount === 1 ? '' : 's'}
        </span>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void openSession(focusedPaneId ?? listPanes(layout)[0]?.id ?? '')
          }
        >
          New session
        </Button>
      </header>

      {error !== null && (
        <p className="rounded border border-[var(--color-destructive)] px-2 py-1 text-xs text-[var(--color-destructive)]">
          {error}
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        <TerminalSplitView
          node={layout}
          client={client}
          terminals={terminals}
          focusedPaneId={focusedPaneId}
          subscribe={subscribe}
          onFocusPane={setFocusedPaneId}
          onAttach={(paneId, terminalId) =>
            setLayout((prev) => attachTerminal(prev, paneId, terminalId))
          }
          onOpenSession={(paneId) => void openSession(paneId)}
          onSplit={split}
          onClosePane={close}
          onRemoveSession={(terminalId) => void removeSession(terminalId)}
          onResize={(splitId, ratio) =>
            setLayout((prev) => setRatio(prev, splitId, ratio))
          }
        />
      </div>
    </div>
  );
}
