import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { daemonFilePath } from '../src/commands/daemon.js';
import type { CliContext } from '../src/context.js';
import { makeProgram } from '../src/program.js';

let root: string;
let fakeHome: string;
let lines: string[];
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-plan-q-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  mkdirSync(join(root, '.dispatch', 'tasks'), { recursive: true });
  lines = [];
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
});

const QUESTIONS = [
  { id: 'q1', question: 'Which checkout flow?', options: ['guest', 'account'] },
];

const PROPOSAL = {
  tasks: [
    {
      title: 'Add guest checkout',
      description: 'd',
      acceptanceCriteria: ['a'],
      blockedByIndices: [],
      priority: 'medium',
    },
  ],
};

// A stand-in daemon whose planner asks a question on the first turn and only
// proposes after a reply — the shape a real planner reaches on turn one.
function startStubDaemon() {
  let answered = false;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/api/health') {
        return Response.json({ ok: true, version: '0.0.1' });
      }
      if (url.pathname === '/api/plan' && req.method === 'POST') {
        return Response.json({ planId: 'plan-42' });
      }
      if (url.pathname === '/api/plan/plan-42/message') {
        answered = true;
        return Response.json({ ok: true });
      }
      if (url.pathname === '/api/plan/plan-42') {
        return Response.json({
          id: 'plan-42',
          prompt: 'redo checkout',
          state: 'ready',
          messages: [
            { role: 'user', text: 'redo checkout', at: '2026-01-01T00:00:00Z' },
            {
              role: 'assistant',
              text: 'One thing first.',
              at: '2026-01-01T00:00:01Z',
            },
          ],
          questions: answered ? [] : QUESTIONS,
          ...(answered ? { proposal: PROPOSAL } : {}),
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:02Z',
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  const daemonsDir = join(fakeHome, '.dispatch', 'daemons');
  mkdirSync(daemonsDir, { recursive: true });
  writeFileSync(
    daemonFilePath(root),
    JSON.stringify({
      port: server.port,
      pid: process.pid,
      rootDir: root,
      startedAt: new Date().toISOString(),
    })
  );
  return server;
}

function context(): CliContext {
  return {
    cwd: root,
    log: (l) => lines.push(l),
    openApp: () => {},
    openBrowser: () => {},
  };
}

describe('a ready plan that asked a question instead of proposing', () => {
  it('prints the question and the reply command instead of an error', async () => {
    const server = startStubDaemon();
    try {
      await makeProgram(context()).parseAsync(['plan', 'redo checkout'], {
        from: 'user',
      });
      const out = lines.join('\n');
      expect(out).toContain('One thing first.');
      expect(out).toContain('Which checkout flow?');
      expect(out).toContain('guest | account');
      expect(out).toContain('dispatch plan reply plan-42');
      expect(out).not.toContain('has no proposal');
    } finally {
      await server.stop(true);
    }
  });

  it('`plan reply` answers it and renders the resulting proposal', async () => {
    const server = startStubDaemon();
    try {
      await makeProgram(context()).parseAsync(
        ['plan', 'reply', 'plan-42', 'guest', 'checkout'],
        { from: 'user' }
      );
      const out = lines.join('\n');
      expect(out).toContain('Add guest checkout');
      expect(out).toContain('dispatch plan confirm plan-42');
    } finally {
      await server.stop(true);
    }
  });
});
