import { seedSession } from '@dispatch/demo/seed';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildStorefrontRunScript } from '../src/script.js';
import { parseDaemonStdout } from '../src/stdoutContract.js';

// GET /api/runs/:id nests `state` under `.meta.state`. A parked approval is a
// tool-approval gate: find it in decisions/open and answer it with a reply.

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
    // The gate must carry the request id the script's approval step raised.
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
      const {
        port,
        agentToken: token,
        appToken,
      } = await parseDaemonStdout(proc.stdout, 20_000);
      expect(port).toBeDefined();
      expect(token).toBeDefined();
      expect(appToken).toBeDefined();

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
          // Gates are read and answered with the app token only, so an agent
          // cannot approve its own parked call.
          const open = await fetch(`${base}/api/decisions/open`, {
            headers: { authorization: `Bearer ${appToken}` },
          });
          const { items } = (await open.json()) as {
            items: {
              id: string;
              data?: { type?: string; runId?: string; requestId?: string };
            }[];
          };
          const gate = items.find(
            (m) => m.data?.type === 'tool-approval' && m.data.runId === runId
          );
          expect(gate?.data?.requestId).toBe(approvalRequestId);
          const reply = await fetch(
            `${base}/api/messages/${gate?.id ?? 'missing'}/reply`,
            {
              method: 'POST',
              headers: {
                authorization: `Bearer ${appToken}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({ body: '', choice: 'approve' }),
            }
          );
          expect(reply.status).toBe(201);
        }
      }
      expect(state).toBe('finished');
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 120_000);
});
