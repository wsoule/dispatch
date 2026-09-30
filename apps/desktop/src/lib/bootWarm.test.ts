import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';

import { hasDispatchKey, launchRootKey, warmBoot } from './bootWarm';

const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe('warmBoot', () => {
  test('seeds the launch root and its has-dispatch answer, then asks for the daemon', async () => {
    const queryClient = client();
    await warmBoot(queryClient, {
      currentProjectRoot: () => Promise.resolve('/repo'),
      hasDispatch: () => Promise.resolve(true),
    });
    expect(queryClient.getQueryData<string>(launchRootKey())).toBe('/repo');
    expect(queryClient.getQueryData<boolean>(hasDispatchKey('/repo'))).toBe(
      true
    );
    // The connection is asked for on the same key App's hook reads (whatever answers
    // it here — a real daemon never does in tests).
    expect(
      queryClient.getQueryState(['dispatchd-port', '/repo'])
    ).toBeDefined();
  });

  test('stops at a missing root or a root without dispatch', async () => {
    const none = client();
    await warmBoot(none, {
      currentProjectRoot: () => Promise.resolve(null),
      hasDispatch: () => Promise.reject(new Error('never asked')),
    });
    expect(none.getQueryCache().getAll()).toHaveLength(1);

    const plain = client();
    await warmBoot(plain, {
      currentProjectRoot: () => Promise.resolve('/plain'),
      hasDispatch: () => Promise.resolve(false),
    });
    expect(plain.getQueryState(['dispatchd-port', '/plain'])).toBeUndefined();
  });
});
