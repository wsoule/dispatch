import { seedSession } from '@dispatch/demo/seed';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildStorefrontRunScript } from '../src/script.js';
import { parseDaemonStdout } from '../src/stdoutContract.js';

// Two shapes below aren't obvious from the route names: GET /api/runs/:id
// nests `state` under `.meta.state`, and the approval route is singular —
// `POST /api/runs/:id/approval`, with `requestId` in the body.

interface TaskDoc {
  meta: { id: string; status: string; blockedBy: string[] };
}

interface RunMeta {
  id: string;
  state: string;
}

interface RunDetail {
  meta: RunMeta;
}

describe('demo daemon', () => {
  test('serves a seeded session and plays a fake run to finished', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'demo-daemon-'));
    const paths = seedSession(dir);
    // GET /api/runs/:id never returns `pendingApproval` (only the live WS
    // event does), so the test reads the approval's requestId from the script.
    const script = buildStorefrontRunScript();
    const approvalStep = (script.steps ?? []).find(
      (s) => s.approval !== undefined
    );
    const approvalRequestId = approvalStep?.approval?.requestId;
    expect(approvalRequestId).toBeDefined();

    const proc = Bun.spawn(
      [
        'bun',
        join(import.meta.dir, '..', 'src', 'daemon.ts'),
        '--root',
        paths.root,
      ],
      {
        env: { ...process.env, DISPATCH_HOME: paths.home },
        stdout: 'pipe',
        // 'inherit', not 'pipe': the daemon's error paths (47 console.error
        // sites in server) would otherwise fill an unread pipe and stall it.
        stderr: 'inherit',
      }
    );
    try {
      const { port, agentToken: token } = await parseDaemonStdout(
        proc.stdout,
        20_000
      );
      expect(port).toBeDefined();
      expect(token).toBeDefined();

      const base = `http://127.0.0.1:${port}`;
      const auth = {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      };

      const tasks = (await (
        await fetch(`${base}/api/tasks`, { headers: auth })
      ).json()) as TaskDoc[];
      // Unblocked only: a blocked todo task stacks its base branch on its
      // blocker's most recent run (orchestrator.ts's resolveBase) — for a
      // seeded blocker still `in-review`, that branch is fixture JSON only,
      // never a real git ref, so the worktree add 500s. A plain unblocked
      // dispatch runs against the real default base branch instead.
      const todo = tasks.find(
        (t) => t.meta.status === 'ready' && t.meta.blockedBy.length === 0
      );
      expect(todo).toBeDefined();

      // No `executor` field in the body — must fall back to 'claude', the
      // name this daemon registers its FakeExecutor under, per api.ts's
      // createRun default and the plan's "never spawn a real agent" rule.
      const created = await fetch(`${base}/api/tasks/${todo!.meta.id}/runs`, {
        method: 'POST',
        headers: auth,
        body: '{}',
      });
      expect(created.status).toBeLessThan(300);
      const { id: runId } = (await created.json()) as RunMeta;

      const deadline = Date.now() + 60_000;
      let state = 'running';
      let approved = false;
      while (
        Date.now() < deadline &&
        state !== 'finished' &&
        state !== 'failed'
      ) {
        await new Promise((r) => setTimeout(r, 1000));
        const run = (await (
          await fetch(`${base}/api/runs/${runId}`, { headers: auth })
        ).json()) as RunDetail;
        state = run.meta.state;
        if (state === 'awaiting-approval' && !approved) {
          approved = true;
          const res = await fetch(`${base}/api/runs/${runId}/approval`, {
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ requestId: approvalRequestId, allow: true }),
          });
          expect(res.status).toBeLessThan(300);
        }
      }
      expect(state).toBe('finished');
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 120_000);
});
