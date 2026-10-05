import { readFileSync } from 'node:fs';

import { readDaemonFile } from '../../daemonfile.js';
import type {
  Executor,
  ExecutorEvents,
  ExecutorRun,
  ExecutorStartOptions,
} from '../types.js';

// The team lesson every fake-remember run proposes.
const PROPOSAL = {
  scope: 'team',
  kind: 'hazard',
  title: 'e2e hazard',
  body: 'x',
} as const;

// The URL of the daemon serving the run's project, or null when none is recorded.
function projectDaemonUrl(opts: ExecutorStartOptions): string | null {
  const info = readDaemonFile(opts.projectRoot ?? opts.cwd);
  return info === null ? null : `http://127.0.0.1:${info.port}`;
}

// The run's own messaging token, or null when it has none.
function runToken(opts: ExecutorStartOptions): string | null {
  if (opts.runTokenFile === undefined) return null;
  const token = readFileSync(opts.runTokenFile, 'utf8').trim();
  return token === '' ? null : token;
}

/**
 * An e2e-only executor (registered under DISPATCH_ENABLE_FAKES) whose run
 * proposes one team hazard through POST /api/memory as itself, then finishes.
 */
export class FakeRememberExecutor implements Executor {
  constructor(
    private readonly daemonUrl: (
      opts: ExecutorStartOptions
    ) => string | null = projectDaemonUrl
  ) {}

  start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun {
    let cancelled = false;
    const fail = (error: string) => {
      if (!cancelled) events.onFinish({ state: 'failed', error });
    };
    const propose = async (): Promise<void> => {
      const token = runToken(opts);
      if (token === null)
        return fail('fake-remember: the run has no run token');
      const url = this.daemonUrl(opts);
      if (url === null)
        return fail('fake-remember: no daemon is serving the project');
      const res = await fetch(`${url}/api/memory`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(PROPOSAL),
      });
      if (!res.ok) {
        return fail(
          `fake-remember: POST /api/memory answered ${res.status}: ${await res.text()}`
        );
      }
      if (cancelled) return;
      events.onEntry({
        ts: new Date().toISOString(),
        kind: 'assistant',
        text: `Proposed a team hazard: ${PROPOSAL.title}`,
      });
      events.onFinish({ state: 'finished', costUsd: 0.01, turns: 1 });
    };
    propose().catch((err: unknown) => {
      fail(`fake-remember: ${(err as Error).message}`);
    });
    return {
      interrupt(): Promise<void> {
        cancelled = true;
        return Promise.resolve();
      },
      requestStop(): void {},
      send(): void {},
      approve(): void {},
      notify(): void {},
    };
  }
}
