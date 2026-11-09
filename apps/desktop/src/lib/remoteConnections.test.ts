import type { PairedCredential } from '@dispatch/client';
import { describe, expect, mock, test } from 'bun:test';

import { resolveDaemonAuth } from './daemonAuth';
import {
  forgetRemoteConnection,
  isRemoteRoot,
  listRemoteConnections,
  pairRemote,
  remoteCacheKey,
  remoteConnectionFor,
  remoteDaemonConnection,
} from './remoteConnections';

// A Storage over a Map, so each test starts empty.
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  };
}

function credential(id = 'd-11112222'): PairedCredential {
  return {
    token: 'device-token',
    device: {
      id,
      name: 'Dispatch app',
      tier: 'decide',
      pairedAt: '2026-10-20T00:00:00.000Z',
      lastUsedAt: null,
    },
    handle: 'owner',
    tier: 'decide',
  };
}

describe('pairRemote', () => {
  test('refuses plain http to another machine before sending anything', async () => {
    const redeem = mock(() => Promise.resolve(credential()));
    const refused = await pairRemote(
      { url: 'http://192.168.1.20:4771', code: 'ABCD-EFGH', deviceName: 'x' },
      { redeem, storage: memoryStorage() }
    ).then(
      () => 'paired',
      (err: Error) => err.message
    );
    expect(refused).toContain('https');
    expect(redeem).not.toHaveBeenCalled();
  });

  test('saves the connection under the remote project’s folder name', async () => {
    const storage = memoryStorage();
    const redeem = mock(() => Promise.resolve(credential()));
    const root = await pairRemote(
      {
        url: 'https://devbox.example.com:4771/board',
        code: ' ABCD-EFGH ',
        deviceName: 'laptop',
      },
      {
        redeem,
        projectRoot: () => Promise.resolve('/home/me/src/api'),
        storage,
      }
    );
    expect(redeem).toHaveBeenCalledWith(
      'https://devbox.example.com:4771',
      'ABCD-EFGH',
      'laptop'
    );
    expect(isRemoteRoot(root)).toBe(true);
    const saved = remoteConnectionFor(root, storage);
    expect(saved).toMatchObject({
      name: 'api',
      baseUrl: 'https://devbox.example.com:4771',
      token: 'device-token',
      tier: 'decide',
    });
  });

  test('pairing the same daemon again replaces its entry', async () => {
    const storage = memoryStorage();
    const input = {
      url: 'http://127.0.0.1:4800',
      code: 'ABCD-EFGH',
      deviceName: 'x',
    };
    await pairRemote(input, {
      redeem: () => Promise.resolve(credential('d-aaaaaaaa')),
      projectRoot: () => Promise.resolve('/srv/app'),
      storage,
    });
    await pairRemote(input, {
      redeem: () => Promise.resolve(credential('d-bbbbbbbb')),
      projectRoot: () => Promise.resolve('/srv/app'),
      storage,
    });
    expect(listRemoteConnections(storage).map((c) => c.id)).toEqual([
      'd-bbbbbbbb',
    ]);
    forgetRemoteConnection('d-bbbbbbbb', storage);
    expect(listRemoteConnections(storage)).toEqual([]);
  });
});

describe('saved remotes', () => {
  test('a hand-edited entry pointing a token at plain http elsewhere is dropped', () => {
    const storage = memoryStorage();
    storage.setItem(
      'dispatch:remote-connections',
      JSON.stringify([
        {
          id: 'd-1',
          name: 'x',
          baseUrl: 'http://evil.example.com',
          token: 't',
          tier: 'operator',
          handle: 'h',
          deviceId: 'd-1',
          remoteRoot: '/x',
          addedAt: '2026-10-20T00:00:00.000Z',
        },
      ])
    );
    expect(listRemoteConnections(storage)).toEqual([]);
  });

  test('cache keys never collide with a real port', () => {
    const a = remoteCacheKey('d-11112222');
    expect(a).toBeLessThan(0);
    expect(remoteCacheKey('d-11112222')).toBe(a);
    expect(remoteCacheKey('d-33334444')).not.toBe(a);
  });

  test('a remote connection presents its device token at its tier', () => {
    const connection = remoteDaemonConnection({
      id: 'd-1',
      name: 'api',
      baseUrl: 'https://devbox:4771',
      token: 'device-token',
      tier: 'request',
      handle: 'owner',
      deviceId: 'd-1',
      remoteRoot: '/srv/api',
      addedAt: '2026-10-20T00:00:00.000Z',
    });
    expect(resolveDaemonAuth(connection)).toEqual({
      token: 'device-token',
      canDecide: false,
      canMessage: true,
    });
    expect(
      resolveDaemonAuth({
        ...connection,
        remote: { token: 'device-token', tier: 'decide' },
      }).canDecide
    ).toBe(true);
  });
});
