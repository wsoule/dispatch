import { describe, expect, it } from 'bun:test';

import { rawFetch } from '../testAuth.js';
import { a2aRun, handoff } from './a2a.js';
import { call, liveRun, useWorld } from './world.js';

// XH-R8: an A2A-origin run's token reaches an allowlist and nothing else:
// messaging, its own task and run, and memory and docs under their A2A rules.
// Every other route is 403, whatever tier the token would otherwise carry.

const world = useWorld();

describe("an A2A-origin run's token", () => {
  it('is refused every route family outside its allowlist', async () => {
    const w = world();
    const owner = await call(w, w.app, 'POST', '/api/tasks', {
      title: 'owner task',
    });
    const otherA2A = await handoff(w, 'rival', 'PRIVATE-HANDOFF', 'PRIVATE');
    const a2a = await a2aRun(w);
    const other = await liveRun(w, w.app, 'other run');
    const ownerId = owner.json.meta.id as string;

    const denied: [string, string, unknown?][] = [
      // Run lists and other runs' transcripts.
      ['GET', '/api/runs'],
      ['GET', `/api/runs/${other.runId}`],
      ['POST', `/api/runs/${other.runId}/evidence`, { command: 'x' }],
      // Files and git.
      ['GET', '/api/files?path=README.md'],
      ['GET', '/api/files/tree'],
      ['GET', '/api/git/status'],
      ['GET', '/api/branches'],
      // Notes, inbox, plans, drafts, search.
      ['GET', '/api/notes'],
      ['GET', '/api/inbox'],
      ['POST', '/api/inbox', { kind: 'note', title: 'x' }],
      ['GET', '/api/plans'],
      ['POST', '/api/tasks/draft', { prompt: 'x' }],
      ['GET', '/api/tasks/drafts'],
      ['POST', '/api/tasks/filter/ai', { query: 'x' }],
      // Decisions and the rest of the board.
      ['GET', '/api/decisions'],
      ['GET', '/api/decisions/open'],
      ['GET', '/api/tasks'],
      ['GET', '/api/tasks/ready'],
      ['POST', '/api/tasks', { title: 'made by the A2A run' }],
      ['GET', `/api/tasks/${ownerId}`],
      ['PATCH', `/api/tasks/${ownerId}`, { body: 'leak\n' }],
      ['GET', `/api/tasks/${otherA2A}`],
      ['GET', `/api/tasks/${ownerId}/comments`],
      ['POST', `/api/tasks/${ownerId}/runs`, {}],
      ['POST', `/api/tasks/${a2a.taskId}/fanout`, { variants: [] }],
      [
        'POST',
        '/api/findings',
        { taskId: ownerId, severity: 'minor', title: 't', detail: 'd' },
      ],
      // Channels, peers, team, presence, config beyond what it needs.
      ['GET', '/api/channels'],
      ['GET', '/api/channels?member=me'],
      ['POST', '/api/channels/leads/members', {}],
      // The bus's flat reads.
      ['GET', `/api/conversations?about=task:${ownerId}`],
      ['GET', `/api/conversations?about=task:${a2a.taskId}`],
      ['GET', '/api/conversations?with=human:test'],
      ['GET', '/api/a2a/peers'],
      ['GET', '/api/presence'],
      ['GET', '/api/people'],
      ['GET', '/api/ledger'],
    ];
    for (const [method, path, body] of denied) {
      const r = await call(w, a2a.runToken, method, path, body);
      expect({ method, path, status: r.status }).toEqual({
        method,
        path,
        status: 403,
      });
      expect(r.text).not.toContain('PRIVATE');
    }
  });

  it('reaches its own task and run, messaging, memory and docs', async () => {
    const w = world();
    const a2a = await a2aRun(w);
    const own = `/api/tasks/${a2a.taskId}`;
    const allowed: [string, string, unknown?][] = [
      ['GET', own],
      ['GET', `${own}/comments`],
      ['POST', `${own}/comments`, { body: 'progress note' }],
      ['POST', `${own}/amend`, { overrides: 'o', reason: 'r' }],
      [
        'POST',
        '/api/findings',
        { taskId: a2a.taskId, severity: 'minor', title: 't', detail: 'd' },
      ],
      ['GET', `/api/runs/${a2a.runId}`],
      [
        'POST',
        `/api/runs/${a2a.runId}/evidence`,
        { command: 'bun test', exitCode: 0, durationMs: 5, summary: 'ok' },
      ],
      ['GET', '/api/mailbox'],
      [
        'POST',
        '/api/messages',
        { to: ['human:test'], kind: 'message', body: 'done soon' },
      ],
      ['GET', '/api/memory/search?q=x'],
      ['GET', '/api/docs'],
      ['GET', '/api/config'],
    ];
    for (const [method, path, body] of allowed) {
      const r = await call(w, a2a.runToken, method, path, body);
      expect({ method, path, ok: r.status < 400 }).toEqual({
        method,
        path,
        ok: true,
      });
    }
  });

  it('opens no event socket', async () => {
    const w = world();
    const a2a = await a2aRun(w);
    const res = await rawFetch(
      `http://127.0.0.1:${w.handle.port}/ws?token=${a2a.runToken}`,
      { headers: { upgrade: 'websocket', connection: 'upgrade' } }
    );
    expect(res.status).toBe(401);
  });

  it("leaves an ordinary run's token at the request tier", async () => {
    const w = world();
    const run = await liveRun(w, w.app, 'ordinary');
    for (const path of ['/api/runs', '/api/tasks', '/api/git/status']) {
      expect((await call(w, run.runToken, 'GET', path)).status).toBe(200);
    }
  });
});
