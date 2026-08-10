import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionCapError, SessionManager } from '../src/sessions.js';

describe('SessionManager', () => {
  test('create seeds, spawns, and parses port+tokens; destroy cleans up', async () => {
    const mgr = new SessionManager({
      sessionsDir: mkdtempSync(join(tmpdir(), 'demo-mgr-')),
      maxSessions: 1,
    });
    try {
      const session = await mgr.create();
      expect(session.port).toBeGreaterThan(0);
      expect(session.agentToken).toMatch(/^[0-9a-f]{64}$/);
      expect(session.appToken).toMatch(/^[0-9a-f]{64}$/);
      const health = await fetch(`http://127.0.0.1:${session.port}/api/health`);
      expect(health.status).toBe(200);

      await expect(mgr.create()).rejects.toBeInstanceOf(SessionCapError);

      const dir = session.paths.dir;
      await mgr.destroy(session.id);
      expect(mgr.get(session.id)).toBeUndefined();
      expect(existsSync(dir)).toBe(false);
    } finally {
      await mgr.stop();
    }
  }, 120_000);

  test('sweep destroys idle sessions', async () => {
    const mgr = new SessionManager({
      sessionsDir: mkdtempSync(join(tmpdir(), 'demo-mgr2-')),
      ttlMs: 1,
    });
    try {
      const s = await mgr.create();
      await new Promise((r) => setTimeout(r, 10));
      await mgr.sweep();
      expect(mgr.get(s.id)).toBeUndefined();
    } finally {
      await mgr.stop();
    }
  }, 120_000);

  test('concurrent create() at cap: exactly one resolves, one rejects fast', async () => {
    const mgr = new SessionManager({
      sessionsDir: mkdtempSync(join(tmpdir(), 'demo-mgr3-')),
      maxSessions: 1,
    });
    try {
      // Fired without awaiting either individually: both create() calls
      // start executing synchronously, so this exercises the cap check
      // racing the first call's seed/spawn/stdout-parse — not two calls
      // that happen to run one after the other.
      const results = await Promise.allSettled([mgr.create(), mgr.create()]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.find(
        (r): r is PromiseRejectedResult => r.status === 'rejected'
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toBeDefined();
      expect(rejected?.reason).toBeInstanceOf(SessionCapError);
      expect(mgr.count()).toBe(1);
    } finally {
      await mgr.stop();
    }
  }, 120_000);
});
