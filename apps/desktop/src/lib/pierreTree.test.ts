import { describe, expect, test } from 'bun:test';

import { normalizeDiffFilePath, toTreeGitStatus } from './pierreTree';

describe('toTreeGitStatus', () => {
  test.each([
    ['A', 'added'],
    ['M', 'modified'],
    ['D', 'deleted'],
    ['R100', 'renamed'],
    ['C87', 'added'],
    ['T', 'modified'],
  ] as const)('maps git code %s to %s', (code, expected) => {
    expect(toTreeGitStatus(code)).toBe(expected);
  });
});

describe('normalizeDiffFilePath', () => {
  test('leaves a plain path untouched', () => {
    expect(normalizeDiffFilePath('src/index.ts')).toBe('src/index.ts');
  });

  test('prefers the destination path of a tab-joined rename line', () => {
    expect(normalizeDiffFilePath('src/old.ts\tsrc/new.ts')).toBe('src/new.ts');
  });
});
