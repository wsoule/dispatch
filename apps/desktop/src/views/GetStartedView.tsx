import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Terminal, TriangleAlert } from 'lucide-react';
import { useState } from 'react';

import { ensureDispatchd } from '../lib/tauri';
import { Button } from '@/ui/button';

interface GetStartedViewProps {
  /** Absolute path of the one project this window is scoped to — shown here specifically
   * because `hasDispatch(projectPath)` came back `false`, i.e. it has no `.dispatch/`
   * tracker yet. */
  projectPath: string;
}

/**
 * First-run / no-tracker screen: shown whenever the app's single active project (see
 * `App.tsx`'s `currentProjectRoot()` resolution) doesn't have a `.dispatch/` tracker yet.
 * The "Initialize project" button drives `ensureDispatchd`, whose Rust sidecar spawns
 * dispatchd with `--init` for a root missing `.dispatch/tasks` (see
 * `sidecar::needs_init`/`BunSpawner::spawn`) — `bin.ts`'s `--init` handling runs
 * `TaskStore.init` before the server starts, so by the time that promise resolves the
 * tracker is already on disk.
 *
 * There is deliberately no copy-paste `dispatch init` command here: a packaged release of
 * this app ships no `dispatch` CLI on `PATH`, so showing one just hands the user a "command
 * not found" dead end. Initialize is the only supported path from this screen.
 */
export function GetStartedView({ projectPath }: GetStartedViewProps) {
  const queryClient = useQueryClient();

  // `initState` tracks the button's own in-flight request; `initError` holds the thrown
  // message (or `null` once cleared by a fresh attempt) — now potentially several lines
  // long (see `ensureDispatchd`'s doc comment on the backend), since a health-wait timeout
  // includes which launch path ran plus a tail of the daemon's own stdout/stderr.
  const [initState, setInitState] = useState<'idle' | 'pending'>('idle');
  const [initError, setInitError] = useState<string | null>(null);

  // Boots dispatchd for this root with `--init` (see this component's doc comment). On
  // success, the daemon has already created `.dispatch/tasks` before `ensureDispatchd`'s
  // promise resolves, so refetching the gate query is sufficient to flip `App` over to the
  // workspace — no extra polling/delay needed.
  async function initialize() {
    setInitState('pending');
    setInitError(null);
    try {
      await ensureDispatchd(projectPath);
      await queryClient.invalidateQueries({
        queryKey: ['has-dispatch', projectPath],
      });
    } catch (err) {
      setInitError(err instanceof Error ? err.message : String(err));
    } finally {
      setInitState('idle');
    }
  }

  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-4 pt-24 text-center">
      <div className="bg-accent text-accent-foreground flex size-10 items-center justify-center rounded-lg">
        <Terminal className="size-5" />
      </div>
      <h1 className="text-foreground text-[15px] font-medium">
        Get started with Dispatch
      </h1>
      <p className="text-muted-foreground text-[13px] leading-relaxed">
        Dispatch tracks tasks as files inside a project&rsquo;s own{' '}
        <code className="bg-secondary rounded px-1 py-0.5 font-mono text-[12px]">
          .dispatch/
        </code>{' '}
        directory. Initialize it below — its Board, Tasks, Runs, and Plans will
        take over automatically once it's ready.
      </p>

      <Button
        onClick={() => void initialize()}
        disabled={initState === 'pending'}
        className="w-full"
      >
        {initState === 'pending' ? (
          <>
            <Loader2 className="size-3.5 animate-spin" /> Initializing…
          </>
        ) : (
          'Initialize project'
        )}
      </Button>

      {initError !== null && (
        <div className="border-destructive/30 bg-destructive/10 text-destructive flex w-full max-w-full items-start gap-2 rounded-lg border px-3 py-2.5 text-left text-[13px]">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <pre className="max-h-48 min-w-0 flex-1 overflow-auto font-mono text-[12px] break-words whitespace-pre-wrap">
            {initError}
          </pre>
        </div>
      )}

      <p className="text-muted-foreground text-[12px] leading-relaxed">
        Initialize creates a{' '}
        <code className="bg-secondary rounded px-1 py-0.5 font-mono text-[11px]">
          .dispatch/
        </code>{' '}
        tracker folder in{' '}
        <code className="bg-secondary rounded px-1 py-0.5 font-mono text-[11px] break-all">
          {projectPath}
        </code>
        .
      </p>
    </div>
  );
}
