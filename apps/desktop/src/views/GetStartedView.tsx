import { useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Loader2, Terminal, TriangleAlert } from 'lucide-react';
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
 * Offers two paths to the same outcome: the primary "Initialize project" button drives
 * `ensureDispatchd`, whose Rust sidecar spawns dispatchd with `--init` for a root missing
 * `.dispatch/tasks` (see `sidecar::needs_init`/`BunSpawner::spawn`) — `bin.ts`'s `--init`
 * handling runs `TaskStore.init` before the server starts, so by the time that promise
 * resolves the tracker is already on disk. The copy-paste `dispatch init` command stays as
 * the secondary/manual path for anyone who'd rather run it themselves (e.g. no `bun` findable
 * by the sidecar, or they want to inspect the CLI's own init output first).
 */
export function GetStartedView({ projectPath }: GetStartedViewProps) {
  const [copied, setCopied] = useState(false);
  const command = `cd ${projectPath} && dispatch init`;
  const queryClient = useQueryClient();

  // Tracks the primary button's own request, separate from `copied`'s ephemeral clipboard
  // toast — `error` holds the thrown message (or `null` once cleared by a fresh attempt).
  const [initState, setInitState] = useState<'idle' | 'pending'>('idle');
  const [initError, setInitError] = useState<string | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied by the OS — the command is still shown as plain text,
      // so it's copyable by hand even if the button silently fails.
    }
  }

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
        <div className="border-destructive/30 bg-destructive/10 text-destructive flex w-full items-start gap-2 rounded-lg border px-3 py-2.5 text-left text-[13px]">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{initError}</span>
        </div>
      )}

      <p className="text-muted-foreground text-[12px]">Or run it yourself:</p>

      <div className="border-border bg-card flex w-full items-center gap-2 rounded-lg border px-3 py-2.5">
        <code className="text-foreground min-w-0 flex-1 truncate text-left font-mono text-[12px]">
          {command}
        </code>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void copy()}
          className="shrink-0"
        >
          {copied ? (
            <>
              <Check className="size-3.5" /> Copied
            </>
          ) : (
            <>
              <Copy className="size-3.5" /> Copy command
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
