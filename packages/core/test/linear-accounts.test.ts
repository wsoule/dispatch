import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  credentialsPath,
  CredentialsUnreadableError,
  readCredentials,
  writeProjectCredential,
} from '../src/credentials.js';
import type { LinearAccountRecord } from '../src/linearAccounts.js';
import {
  hasLinearAccounts,
  linearRefreshLockPath,
  publicLinearAccount,
  readLinearAccount,
  removeLinearAccount,
  replaceLinearAccountTokens,
  withLinearRefreshLock,
  writeLinearAccount,
} from '../src/linearAccounts.js';

let fakeHome: string;
const originalHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-linear-accounts-'));
  process.env.DISPATCH_HOME = fakeHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

function record(
  overrides: Partial<LinearAccountRecord> = {}
): LinearAccountRecord {
  return {
    version: 1,
    clientId: 'client-1',
    accessToken: 'lin_oauth_access_1',
    refreshToken: 'lin_oauth_refresh_1',
    expiresAt: '2030-01-01T00:00:00.000Z',
    scope: ['read', 'write'],
    user: {
      id: 'u-ada',
      name: 'Ada Lovelace',
      displayName: 'ada',
      email: 'ada@example.com',
      guest: false,
      admin: false,
    },
    organization: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
    signedInAt: '2026-11-05T00:00:00.000Z',
    refreshedAt: null,
    ...overrides,
  };
}

describe('linearAccounts storage', () => {
  it('writes the record 0600 into credentials.json, keyed by organization', async () => {
    expect(hasLinearAccounts()).toBe(false);
    expect(await writeLinearAccount(record())).toBeNull();
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
    expect(readLinearAccount('org-1')).toEqual(record());
    expect(readLinearAccount('org-2')).toBeNull();
    expect(hasLinearAccounts()).toBe(true);
    const raw = JSON.parse(readFileSync(credentialsPath(), 'utf8')) as {
      linearAccounts: Record<string, unknown>;
    };
    expect(Object.keys(raw.linearAccounts)).toEqual(['org-1']);
  });

  it('stays 0600 when the file already exists, and keeps the other slots', async () => {
    writeProjectCredential('/tmp/project', 'linear', { apiKey: 'lin_api_x' });
    await writeLinearAccount(record());
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
    expect(Object.keys(readCredentials().projects ?? {})).toHaveLength(1);
  });

  it('answers the record a new sign-in replaced', async () => {
    await writeLinearAccount(record());
    const replaced = await writeLinearAccount(
      record({ accessToken: 'lin_oauth_access_2', refreshToken: 'r2' })
    );
    expect(replaced?.refreshToken).toBe('lin_oauth_refresh_1');
    expect(readLinearAccount('org-1')?.refreshToken).toBe('r2');
  });

  it('reads a malformed record as absent', () => {
    mkdirSync(dirname(credentialsPath()), { recursive: true });
    writeFileSync(
      credentialsPath(),
      JSON.stringify({
        linearAccounts: {
          'org-1': { ...record(), accessToken: 42 },
          'org-2': 'nope',
        },
      })
    );
    expect(readLinearAccount('org-1')).toBeNull();
    expect(readLinearAccount('org-2')).toBeNull();
  });

  it('replaces tokens only while the stored refresh token matches', async () => {
    await writeLinearAccount(record());
    const next = {
      accessToken: 'a2',
      refreshToken: 'r2',
      expiresAt: '2031-01-01T00:00:00.000Z',
      scope: ['read', 'write'],
      refreshedAt: '2026-11-05T01:00:00.000Z',
    };
    expect(await replaceLinearAccountTokens('org-1', 'stale', next)).toBe(
      false
    );
    expect(readLinearAccount('org-1')?.accessToken).toBe('lin_oauth_access_1');
    expect(
      await replaceLinearAccountTokens('org-1', 'lin_oauth_refresh_1', next)
    ).toBe(true);
    const stored = readLinearAccount('org-1');
    expect(stored?.accessToken).toBe('a2');
    expect(stored?.refreshedAt).toBe('2026-11-05T01:00:00.000Z');
    expect(stored?.user.id).toBe('u-ada');
    expect(await replaceLinearAccountTokens('org-9', 'r2', next)).toBe(false);
  });

  it('removes a record, by compare-and-set when asked', async () => {
    await writeLinearAccount(record());
    expect(await removeLinearAccount('org-1', 'stale')).toBeNull();
    expect(readLinearAccount('org-1')).not.toBeNull();
    const removed = await removeLinearAccount('org-1', 'lin_oauth_refresh_1');
    expect(removed?.accessToken).toBe('lin_oauth_access_1');
    expect(readLinearAccount('org-1')).toBeNull();
    expect(readCredentials().linearAccounts).toBeUndefined();
    expect(await removeLinearAccount('org-1')).toBeNull();
  });

  it('never overwrites a credentials file it cannot parse', async () => {
    mkdirSync(dirname(credentialsPath()), { recursive: true });
    writeFileSync(credentialsPath(), '{ not json');
    expect(readLinearAccount('org-1')).toBeNull();
    expect(hasLinearAccounts()).toBe(false);
    let thrown: unknown = null;
    try {
      await writeLinearAccount(record());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CredentialsUnreadableError);
    expect(readFileSync(credentialsPath(), 'utf8')).toBe('{ not json');
  });

  it('summarizes a record without its tokens', () => {
    const summary = publicLinearAccount(record({ scope: ['read'] }));
    expect(summary).toEqual({
      userId: 'u-ada',
      name: 'Ada Lovelace',
      displayName: 'ada',
      email: 'ada@example.com',
      guest: false,
      admin: false,
      canWrite: false,
      workspace: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
      signedInAt: '2026-11-05T00:00:00.000Z',
    });
    expect(JSON.stringify(summary)).not.toContain('lin_oauth_');
  });
});

describe('withLinearRefreshLock', () => {
  it('keeps a second holder out until the first releases', async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withLinearRefreshLock(async () => {
      order.push('first in');
      await firstHeld;
      order.push('first out');
    });
    await Bun.sleep(20);
    const second = withLinearRefreshLock(() => {
      order.push('second in');
      return Promise.resolve();
    });
    await Bun.sleep(50);
    expect(order).toEqual(['first in']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first in', 'first out', 'second in']);
    expect(existsSync(linearRefreshLockPath())).toBe(false);
  });

  it('takes over a lock its holder abandoned', async () => {
    const child = Bun.spawn([process.execPath, '-e', '0']);
    await child.exited;
    mkdirSync(dirname(linearRefreshLockPath()), { recursive: true });
    writeFileSync(linearRefreshLockPath(), `${child.pid} abandoned\n`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(linearRefreshLockPath(), old, old);
    expect(await withLinearRefreshLock(() => Promise.resolve('ran'))).toBe(
      'ran'
    );
  });

  it('is a different file from the credentials lock', () => {
    expect(linearRefreshLockPath()).toBe(
      `${credentialsPath()}.linear-refresh.lock`
    );
  });
});
