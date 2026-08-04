import { describe, expect, test } from 'bun:test';

import {
  configChangedQueryKeys,
  dispatchConfigKey,
  linearStatusKey,
  syncStatusKey,
} from './configEvents';

describe('configChangedQueryKeys', () => {
  test('refetches the project config', () => {
    expect(configChangedQueryKeys(4771)).toContainEqual(
      dispatchConfigKey(4771)
    );
  });

  test('refetches Linear status, which connect/disconnect changes without touching config.yml', () => {
    expect(configChangedQueryKeys(4771)).toContainEqual(linearStatusKey(4771));
  });

  test('refetches sync status — autoCommit lives in the same config file the chip reads', () => {
    expect(configChangedQueryKeys(4771)).toContainEqual(syncStatusKey(4771));
  });

  test('keys are port-scoped, so a second project window is not invalidated', () => {
    expect(configChangedQueryKeys(4771)).not.toContainEqual(
      dispatchConfigKey(4772)
    );
  });

  test('returns nothing else — every key here costs a refetch on every config write', () => {
    expect(configChangedQueryKeys(4771)).toHaveLength(3);
  });
});
