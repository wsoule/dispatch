import { describe, expect, test } from 'bun:test';

import { runKindLabel } from './runKind';

describe('runKindLabel', () => {
  test('labels every kind, defaulting an absent one to execute', () => {
    expect(runKindLabel('execute')).toBe('Execute');
    expect(runKindLabel('review')).toBe('Review');
    expect(runKindLabel('verify')).toBe('Verify');
    expect(runKindLabel(undefined)).toBe('Execute');
  });
});
