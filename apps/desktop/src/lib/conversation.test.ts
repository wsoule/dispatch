import { describe, expect, it } from 'bun:test';

import {
  snippetFromSelection,
  snippetLabel,
  subjectForRun,
} from './conversation';

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

describe('snippetFromSelection', () => {
  it('carries the selection over as the persisted shape', () => {
    expect(
      snippetFromSelection({
        file: 'src/a.ts',
        startLine: 2,
        endLine: 4,
        text: 'const a = 1;',
      })
    ).toEqual({
      file: 'src/a.ts',
      startLine: 2,
      endLine: 4,
      text: 'const a = 1;',
    });
  });

  // A drag upward hands back its anchor first, and a chip reading `(9-3)` would be nonsense.
  it('orders a backwards selection', () => {
    expect(
      snippetFromSelection({
        file: 'src/a.ts',
        startLine: 9,
        endLine: 3,
        text: 'x',
      })
    ).toMatchObject({ startLine: 3, endLine: 9 });
  });
});
