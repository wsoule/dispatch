import { describe, expect, it } from 'bun:test';

import {
  snippetFromSelection,
  snippetLabel,
  snippetText,
  subjectForRun,
} from './conversation';

const CONTENTS = 'const a = 0;\nconst b = 1;\nconst c = 2;\n';

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

describe('snippetText', () => {
  it('takes the lines inclusively, 1-based', () => {
    expect(snippetText(CONTENTS, 2, 3)).toBe('const b = 1;\nconst c = 2;');
  });

  it('takes a single line', () => {
    expect(snippetText(CONTENTS, 1, 1)).toBe('const a = 0;');
  });

  // A line number below 1 would make `slice` count from the END of the file, which would
  // attach text from somewhere else entirely rather than nothing.
  it('never counts back from the end of the file', () => {
    expect(snippetText(CONTENTS, 0, 1)).toBe('const a = 0;');
  });

  it('stops at the last line when the range runs past it', () => {
    expect(snippetText(CONTENTS, 3, 99)).toBe('const c = 2;\n');
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
