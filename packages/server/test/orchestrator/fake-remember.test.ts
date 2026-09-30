import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeRememberExecutor } from '../../src/orchestrator/executors/fakeRemember.js';
import type { ExecutorEvents } from '../../src/orchestrator/types.js';

interface Seen {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

let server: ReturnType<typeof Bun.serve> | null = null;

// A stand-in daemon that records each request and answers with `status`.
function stubDaemon(status: number): { url: string; seen: Seen[] } {
  const seen: Seen[] = [];
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      seen.push({
        method: req.method,
        path: new URL(req.url).pathname,
        authorization: req.headers.get('authorization'),
        body: await req.json(),
      });
      return Response.json({ ok: status < 400 }, { status });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

function tokenFile(token: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fake-remember-')));
  const path = join(dir, 'run.token');
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return path;
}

// Starts one run and resolves with what it finished with.
function runOnce(
  executor: FakeRememberExecutor,
  runTokenFile?: string
): Promise<{
  finish: Parameters<ExecutorEvents['onFinish']>[0];
  said: string[];
}> {
  const said: string[] = [];
  return new Promise((resolve) => {
    executor.start(
      {
        cwd: tmpdir(),
        prompt: 'remember',
        permissionMode: 'auto',
        ...(runTokenFile === undefined ? {} : { runTokenFile }),
      },
      {
        onEntry: (e) => said.push(e.text ?? ''),
        onApprovalRequest: () => {},
        onFinish: (finish) => resolve({ finish, said }),
      }
    );
  });
}

afterEach(() => {
  void server?.stop(true);
  server = null;
});

describe('FakeRememberExecutor', () => {
  it('proposes the e2e team hazard with its run token, then finishes', async () => {
    const daemon = stubDaemon(201);
    const executor = new FakeRememberExecutor(() => daemon.url);
    const { finish, said } = await runOnce(executor, tokenFile('run-token-1'));
    expect(daemon.seen).toEqual([
      {
        method: 'POST',
        path: '/api/memory',
        authorization: 'Bearer run-token-1',
        body: { scope: 'team', kind: 'hazard', title: 'e2e hazard', body: 'x' },
      },
    ]);
    expect(finish.state).toBe('finished');
    expect(said.join('\n')).toContain('e2e hazard');
  });

  it('fails the run with the status when the daemon refuses the proposal', async () => {
    const daemon = stubDaemon(403);
    const executor = new FakeRememberExecutor(() => daemon.url);
    const { finish } = await runOnce(executor, tokenFile('run-token-2'));
    expect(finish.state).toBe('failed');
    expect(finish.error).toContain('403');
  });

  it('fails the run, posting nothing, without a run token or a daemon', async () => {
    const daemon = stubDaemon(201);
    const noToken = await runOnce(new FakeRememberExecutor(() => daemon.url));
    expect(noToken.finish.state).toBe('failed');
    expect(noToken.finish.error).toContain('run token');
    const noDaemon = await runOnce(
      new FakeRememberExecutor(() => null),
      tokenFile('run-token-3')
    );
    expect(noDaemon.finish.state).toBe('failed');
    expect(noDaemon.finish.error).toContain('daemon');
    expect(daemon.seen).toEqual([]);
  });
});
