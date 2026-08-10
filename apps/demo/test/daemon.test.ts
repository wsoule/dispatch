import { seedSession } from '@dispatch/demo/seed';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildStorefrontRunScript } from '../src/script.js';

// TaskDoc/RunMeta/RunDetail field shapes below are confirmed against
// packages/server/src/api.ts and packages/core/src/types.ts rather than
// guessed:
//  - GET /api/tasks returns TaskDoc[] = { meta: { id, status, ... }, body },
//    not a flat { id, status }.
//  - POST /api/tasks/:id/runs returns RunMeta (flat { id, state, ... }).
//  - GET /api/runs/:id returns RunDetail = { meta: RunMeta, entries, ... } —
//    the run's `state` lives at `.meta.state`, not the top level.
//  - The approval route is `POST /api/runs/:id/approval` (singular, body
//    carries `requestId`), not `/api/runs/:id/approvals/:requestId`.
//    `pendingApproval` is never returned by GET /api/runs/:id — see
//    apps/desktop/src/hooks/useDispatchProject.ts's own comment: "the REST
//    API has no way to hand back a paused run's requestId on a plain
//    refetch, only the live WS event". Since this daemon's script is fixed
//    and known ahead of time, the test reads the approval's requestId
//    straight from `buildStorefrontRunScript()` instead of standing up a WS
//    listener just to relearn a value it already has.

async function readUntil(
  proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>,
  patterns: RegExp[]
): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  const reader = proc.stdout.getReader();
  let buf = '';
  const deadline = Date.now() + 20_000;
  while (Object.keys(found).length < patterns.length && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    for (const p of patterns) {
      const m = p.exec(buf);
      if (m !== null) found[p.source] = m[1] ?? m[0];
    }
  }
  reader.releaseLock();
  return found;
}

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
    // The daemon's fake executor plays this same script; its approval step
    // pauses the run under this requestId (see the module doc comment above).
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
        stderr: 'pipe',
      }
    );
    try {
      const out = await readUntil(proc, [
        /listening on http:\/\/127\.0\.0\.1:(\d+)/,
        /DISPATCH_AGENT_TOKEN=([0-9a-f]+)/,
      ]);
      const port = out['listening on http:\\/\\/127\\.0\\.0\\.1:(\\d+)'];
      const token = out['DISPATCH_AGENT_TOKEN=([0-9a-f]+)'];
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
        (t) => t.meta.status === 'todo' && t.meta.blockedBy.length === 0
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
