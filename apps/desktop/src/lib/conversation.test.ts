import { describe, expect, it } from 'bun:test';

import { snippetLabel, subjectForRun } from './conversation';

describe('snippetLabel', () => {
  it('renders a range', () => {
    expect(
      snippetLabel({ file: 'src/a.ts', startLine: 2, endLine: 4, text: '' })
    ).toBe('src/a.ts (2-4)');
  });

  it('collapses a single line to one number', () => {
    expect(
      snippetLabel({ file: 'src/a.ts', startLine: 7, endLine: 7, text: '' })
    ).toBe('src/a.ts (7)');
  });
});

describe('subjectForRun', () => {
  it('namespaces a run id', () => {
    expect(subjectForRun('r-abc')).toBe('run:r-abc');
  });
});
