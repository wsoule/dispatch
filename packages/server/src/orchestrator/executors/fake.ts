import type {
  Executor,
  ExecutorEvents,
  ExecutorRun,
  ExecutorStartOptions,
  NormalizedEntry,
} from '../types.js';

// One scripted step: emit a log entry, write (and commit) real files into
// the run's worktree, and/or raise an approval request that pauses the
// script until the orchestrator calls `approve()`. A step can combine an
// entry with a write/approval — the fields are independent, all optional,
// applied in entry -> write -> approval order.
export interface FakeStep {
  entry?: NormalizedEntry;
  write?: (cwd: string) => void;
  commitMessage?: string;
  // When false, `write`'s changes are left uncommitted in the worktree
  // instead of the usual auto-commit — lets a test script an executor that
  // "forgets" to commit, to exercise the orchestrator's own onFinish
  // safety net (see orchestrator.ts's autoCommitIfDirty). Defaults to true,
  // matching every existing script's assumption that a write step commits.
  commit?: boolean;
  approval?: { requestId: string; toolName: string; input: unknown };
}

export interface FakeFinish {
  state: 'finished' | 'failed';
  costUsd?: number;
  turns?: number;
  sessionId?: string;
  error?: string;
}

export interface FakeExecutorScript {
  steps?: FakeStep[];
  finish: FakeFinish;
}

// Runs `git add -A && git commit -m <message>` in `cwd` — the real git
// commit a FakeExecutor step performs after a scripted file write, so tests
// that dispatch through the orchestrator can assert on real downstream git
// state (diff, merge, discard) exactly as the plan requires.
function commitAll(cwd: string, message: string): void {
  Bun.spawnSync(['git', 'add', '-A'], { cwd });
  Bun.spawnSync(['git', 'commit', '-m', message], { cwd });
}

/**
 * A scriptable stand-in for a real agent executor (the Claude Agent SDK
 * arrives in O2). A FakeExecutor is constructed with a fixed script of
 * steps and a finish result; `start()` plays the script back, pausing at
 * any approval gate until the orchestrator's `approve()` call resumes it,
 * and stopping immediately if `interrupt()` is called.
 */
export class FakeExecutor implements Executor {
  constructor(private readonly script: FakeExecutorScript) {}

  start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun {
    let cancelled = false;
    const pendingApprovals = new Map<string, (allow: boolean) => void>();

    // I6: a scripted step throwing (a bad `write` callback, a commit that
    // fails, etc.) must never leave this run silently hung mid-script — a
    // zombie run stuck "running" forever with nothing left driving it
    // forward. The whole loop runs inside one try/catch specifically so any
    // such failure still reaches `onFinish`, exactly like a real executor
    // crashing partway through would.
    const playScript = async (): Promise<void> => {
      try {
        for (const step of this.script.steps ?? []) {
          if (cancelled) return;

          if (step.entry !== undefined) events.onEntry(step.entry);

          if (step.write !== undefined) {
            step.write(opts.cwd);
            if (step.commit ?? true) {
              commitAll(opts.cwd, step.commitMessage ?? 'fake executor commit');
            }
          }

          if (step.approval !== undefined) {
            const approval = step.approval;
            events.onApprovalRequest(approval);
            const allow = await new Promise<boolean>((resolve) => {
              pendingApprovals.set(approval.requestId, resolve);
            });
            if (cancelled) return;
            if (!allow) {
              events.onFinish({ state: 'failed', error: 'approval denied' });
              return;
            }
          }
        }
        if (cancelled) return;
        events.onFinish(this.script.finish);
      } catch (err) {
        if (!cancelled) {
          events.onFinish({
            state: 'failed',
            error: (err as Error).message,
          });
        }
      }
    };

    // Fire-and-forget: `start()` must return the ExecutorRun handle
    // synchronously so the orchestrator can register it before any events
    // land, exactly like a real streaming executor would.
    void playScript();

    return {
      interrupt(): Promise<void> {
        cancelled = true;
        for (const resolve of pendingApprovals.values()) resolve(false);
        pendingApprovals.clear();
        return Promise.resolve();
      },
      // Mid-run user messages aren't part of an O1 script — the seam exists
      // so the interface matches the real executor; FakeExecutor has
      // nothing useful to do with it.
      send(): void {},
      approve(requestId: string, allow: boolean): void {
        const resolve = pendingApprovals.get(requestId);
        if (resolve !== undefined) {
          pendingApprovals.delete(requestId);
          resolve(allow);
        }
      },
    };
  }
}
