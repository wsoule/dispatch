import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  frozenBySharing,
  SharingState,
  turnOnSharing,
} from '../../../src/team/federation/sharing.js';
import type { SharingDeps } from '../../../src/team/federation/sharing.js';

// Turning board sync on by restarting: one restart however many ask, nothing
// new starts in the window, and nothing is left half done.
let root: string;
let state: SharingState;
const config = () => join(root, '.dispatch', 'config.yml');
const ORIGINAL = '# mine\nsync:\n  enabled: false\n  intervalSec: 3600\n';

beforeEach(() => {
  state = new SharingState();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'sharing-')));
  mkdirSync(join(root, '.dispatch'));
  writeFileSync(config(), ORIGINAL);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// Fakes that record what happened; `live` is what liveWork answers, in turn.
function deps(over: Partial<SharingDeps> & { live?: string[][] } = {}) {
  const log: string[] = [];
  const live = over.live ?? [[], []];
  let i = 0;
  let finished: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const d: SharingDeps = {
    rootDir: root,
    state,
    backend: 'sqlite',
    now: () => new Date(),
    liveWork: () => live[Math.min(i++, live.length - 1)] ?? [],
    resolveRemote: () => Promise.resolve('/remote.git'),
    hold: (why) => log.push(`hold ${why.slice(0, 10)}`),
    release: () => log.push('release'),
    restart: () => {
      log.push('restart');
      return Promise.resolve();
    },
    delayMs: 1,
    settled: () => finished(),
    ...over,
  };
  return { d, log, done };
}

describe('turnOnSharing', () => {
  it('writes the config, holds new work, and restarts once however many ask', async () => {
    const { d, log, done } = deps();
    const [a, b] = await Promise.all([turnOnSharing(d), turnOnSharing(d)]);
    expect(a.ok && b.ok).toBe(true);
    expect(state.pending).toBe(true);
    expect(frozenBySharing(state, 'POST', ['tasks', 't-1', 'runs'])).toBe(true);
    expect(frozenBySharing(state, 'GET', ['tasks'])).toBe(false);
    expect(frozenBySharing(state, 'POST', ['team', 'join'])).toBe(false);
    await done;
    expect(log.filter((l) => l === 'restart')).toHaveLength(1);
    expect(log[0]).toMatch(/^hold /);
    expect(readFileSync(config(), 'utf8')).toContain('enabled: true');
    expect(state.pending).toBe(false);
  });

  it('gives up, rolls the config back and releases when work started in the window', async () => {
    const { d, log, done } = deps({ live: [[], ['1 live run']] });
    expect((await turnOnSharing(d)).ok).toBe(true);
    await done;
    expect(log).not.toContain('restart');
    expect(log).toContain('release');
    expect(readFileSync(config(), 'utf8')).toBe(ORIGINAL);
    expect(state.pending).toBe(false);
  });

  it('hands the restart a rollback that restores the config byte for byte', async () => {
    const { d, done } = deps({
      restart: (rollback) => {
        rollback();
        return Promise.reject(new Error('port in use'));
      },
    });
    await turnOnSharing(d);
    await done;
    expect(readFileSync(config(), 'utf8')).toBe(ORIGINAL);
    expect(state.pending).toBe(false);
  });

  it('rolls a config that did not exist back to none', async () => {
    rmSync(config());
    const { d, done } = deps({ live: [[], ['1 terminal']] });
    await turnOnSharing(d);
    await done;
    expect(existsSync(config())).toBe(false);
  });

  it('refuses up front while work is live, writing nothing', async () => {
    const { d, log } = deps({ live: [['2 live runs']] });
    const answer = await turnOnSharing(d);
    expect(answer.ok).toBe(false);
    expect(answer.ok ? '' : answer.error).toContain('2 live runs');
    expect(log).toEqual([]);
    expect(readFileSync(config(), 'utf8')).toBe(ORIGINAL);
    expect(state.pending).toBe(false);
  });

  it('keeps one server’s pending mark from ever reaching another server', async () => {
    const other = new SharingState();
    const { d, done } = deps();
    await turnOnSharing(d);
    expect(state.pending).toBe(true);
    // Another daemon in the same process, even on the same project root.
    expect(other.pending).toBe(false);
    expect(frozenBySharing(other, 'POST', ['a2a', 'relay'])).toBe(false);
    expect(frozenBySharing(undefined, 'POST', ['tasks'])).toBe(false);
    const second = deps();
    const answer = await turnOnSharing({ ...second.d, state: other });
    expect(answer.ok).toBe(true);
    await Promise.all([done, second.done]);
    expect(second.log.filter((l) => l === 'restart')).toHaveLength(1);
  });

  it('clears the mark when the server stops', () => {
    expect(state.claim()).toBe(true);
    expect(state.claim()).toBe(false);
    state.clear();
    expect(state.pending).toBe(false);
  });
});
