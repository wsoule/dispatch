import { describe, expect, it } from 'bun:test';

import {
  locateSnippetLines,
  snippetFromSelection,
  snippetLabel,
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

describe('locateSnippetLines', () => {
  it('finds a single selected line', () => {
    expect(locateSnippetLines(CONTENTS, 'const b = 1;')).toEqual({
      startLine: 2,
      endLine: 2,
    });
  });

  it('finds a selection spanning rows', () => {
    expect(locateSnippetLines(CONTENTS, 'const b = 1;\nconst c = 2;')).toEqual({
      startLine: 2,
      endLine: 3,
    });
  });

  // A drag that starts and ends mid-line still belongs to the lines it crosses.
  it('takes the lines a partial selection crosses', () => {
    expect(locateSnippetLines(CONTENTS, 'b = 1;\nconst c')).toEqual({
      startLine: 2,
      endLine: 3,
    });
  });

  // Ending a drag past the end of a row includes its newline; the line after it was not
  // selected and must not be named.
  it('does not count a trailing newline as another line', () => {
    expect(locateSnippetLines(CONTENTS, 'const b = 1;\n')).toEqual({
      startLine: 2,
      endLine: 2,
    });
  });

  // No match is the honest answer for a selection that crossed the deleted side of a split
  // diff, or one taken while the file on disk had already moved on.
  it('reports nothing when the text is not in this file', () => {
    expect(locateSnippetLines(CONTENTS, 'const zzz = 9;')).toBeNull();
  });

  it('reports nothing for an empty selection', () => {
    expect(locateSnippetLines(CONTENTS, '')).toBeNull();
  });

  // Two identical spans cannot be told apart from the text alone; the first is the answer, and
  // the snippet still carries the exact code either way.
  it('takes the first of several identical spans', () => {
    expect(locateSnippetLines('a\nx\nb\nx\n', 'x')).toEqual({
      startLine: 2,
      endLine: 2,
    });
  });
});
