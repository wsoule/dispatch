import { noul } from '@typesafe-ai/sdk';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  capText,
  createJudgmentClient,
  lastJudgmentFailure,
  probeJudgments,
  warnOnce,
} from '../../src/judgments/client';

// Each test gets its own DISPATCH_HOME so credentials.json never leaks in,
// and its own project root for loadConfig to read models.judge from.
let home: string;
let root: string;
const originalHome = process.env.DISPATCH_HOME;
const originalKey = process.env.TYPESAFE_API_KEY;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dispatch-judge-home-'));
  root = mkdtempSync(join(tmpdir(), 'dispatch-judge-root-'));
  mkdirSync(join(root, '.dispatch'), { recursive: true });
  process.env.DISPATCH_HOME = home;
  delete process.env.TYPESAFE_API_KEY;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = originalKey;
});

// A fetch that records the request and answers every call with `body`.
function fakeFetch(body: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
  };
  return { fetch, calls };
}

describe('createJudgmentClient', () => {
  test('returns null when no key resolves', () => {
    expect(createJudgmentClient(root)).toBeNull();
  });

  test('uses the env key and the configured judge model', async () => {
    process.env.TYPESAFE_API_KEY = 'k-env';
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'models:\n  judge: jev-1.13.0\n'
    );
    const { fetch, calls } = fakeFetch({
      model: 'jev-1.13.0',
      answers: { ok: { type: 'noul', noul: 0.9 } },
      usage: { input_tokens: 1, output_tokens: 0 },
    });
    const client = createJudgmentClient(root, { fetch });
    expect(client).not.toBeNull();
    expect(client?.model).toBe('jev-1.13.0');

    const result = await client!.judge('some state', { ok: noul('is it?') });
    expect(result.answers.ok.noul).toBe(0.9);

    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get('authorization')).toBe('Bearer k-env');
    const sent = JSON.parse(calls[0].init?.body as string) as {
      model: string;
      state: string;
    };
    expect(sent.model).toBe('jev-1.13.0');
    expect(sent.state).toBe('some state');
  });

  test('an explicit apiKey wins over the environment', () => {
    process.env.TYPESAFE_API_KEY = 'k-env';
    const client = createJudgmentClient(root, { apiKey: 'k-explicit' });
    expect(client).not.toBeNull();
  });

  test('propagates a transport failure instead of swallowing it', async () => {
    process.env.TYPESAFE_API_KEY = 'k';
    const failing = () =>
      Promise.resolve(new Response('{"error":"nope"}', { status: 401 }));
    const client = createJudgmentClient(root, { fetch: failing });
    await expect(client!.judge('s', { ok: noul('q') })).rejects.toThrow();
  });
});

describe('capText', () => {
  test('leaves short text alone', () => {
    expect(capText('abc', 10)).toBe('abc');
  });

  test('cuts and marks long text', () => {
    expect(capText('a'.repeat(10), 4)).toBe('aaaa\n[truncated]');
  });
});

describe('warnOnce', () => {
  test('logs once per feature', () => {
    const seen: string[] = [];
    const original = console.warn;
    console.warn = (msg: string) => {
      seen.push(msg);
    };
    try {
      warnOnce('unit-feature', new Error('boom'));
      warnOnce('unit-feature', new Error('boom again'));
      warnOnce('unit-feature-2', new Error('other'));
    } finally {
      console.warn = original;
    }
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain('unit-feature');
    expect(seen[0]).toContain('boom');
  });
});

describe('status for Settings', () => {
  test('warnOnce keeps the latest failure even after it stops logging', () => {
    warnOnce('status-feature', new Error('first'));
    warnOnce('status-feature', new Error('second'));
    expect(lastJudgmentFailure()).toMatchObject({
      feature: 'status-feature',
      message: 'second',
    });
  });

  test('probeJudgments times a working call and reports a failing one', async () => {
    const ok = await probeJudgments({
      model: 'jev-test',
      judge: () => Promise.resolve({} as never),
    });
    expect(ok.ok).toBe(true);
    const bad = await probeJudgments({
      model: 'jev-test',
      judge: () => Promise.reject(new Error('401 Unauthorized')),
    });
    expect(bad).toEqual({ ok: false, error: '401 Unauthorized' });
  });
});
