import { describe, expect, test } from 'bun:test';

import { formatBytes } from './formatBytes';

describe('formatBytes', () => {
  test('uses base 1024 and short units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024 * 1.4)).toBe('1.4 GB');
  });

  test('drops the decimal below a megabyte, where it is noise', () => {
    expect(formatBytes(1536)).toBe('2 KB');
  });

  test('drops the decimal for large values, where it is also noise', () => {
    expect(formatBytes(1024 * 1024 * 512)).toBe('512 MB');
  });

  test('nothing on disk reads as nothing, not NaN', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});
