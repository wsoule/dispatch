import { markBlockingSection } from './watchdog.js';

export interface BlockingGitOptions {
  env?: Record<string, string | undefined>;
  /**
   * Hard deadline. The child is SIGKILLed, not SIGTERMed, when it expires:
   * Bun's spawnSync sends its kill signal once and then waits for the child
   * to exit, so a child that ignores SIGTERM (or is stuck in a syscall behind
   * a stalled ssh session) turns the timeout into no timeout at all — measured
   * on bun 1.3.14, the runtime the shipped daemon is compiled with.
   */
  timeoutMs?: number;
}

export interface BlockingGitResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when `timeoutMs` expired before git exited. */
  timedOut: boolean;
}

// Trims one argument for the watchdog label: a commit message or a patch body
// says nothing about *where* the daemon is stuck, the command shape does.
function shortArg(arg: string): string {
  const flat = arg.replace(/\s+/g, ' ');
  return flat.length > 40 ? `${flat.slice(0, 37)}...` : flat;
}

/**
 * The one way the daemon runs git synchronously on its event loop.
 *
 * Every call here blocks HTTP, WebSockets and every timer for as long as git
 * takes, so each one first names itself to the event-loop watchdog: when the
 * loop stalls, the daemon log says `git pull --rebase origin main (cwd ...)`
 * instead of nothing. Local operations pass no timeout — a slow `git cherry`
 * on a big repo is slow, not stuck — while anything that can touch a network
 * or a prompt passes one and gets a real kill.
 */
export function spawnGitSync(
  cwd: string,
  args: string[],
  opts: BlockingGitOptions = {}
): BlockingGitResult {
  markBlockingSection(`git ${args.map(shortArg).join(' ')} (cwd ${cwd})`);
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.timeoutMs !== undefined
      ? { timeout: opts.timeoutMs, killSignal: 'SIGKILL' as const }
      : {}),
  });
  const timedOut = result.exitedDueToTimeout === true;
  let stderr = result.stderr.toString('utf8');
  if (timedOut) {
    stderr = `${stderr}${stderr.endsWith('\n') || stderr === '' ? '' : '\n'}git ${args[0] ?? ''} killed after ${String(opts.timeoutMs)}ms\n`;
  }
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString('utf8'),
    stderr,
    timedOut,
  };
}
