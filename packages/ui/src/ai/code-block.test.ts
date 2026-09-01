import { describe, expect, test } from 'bun:test';

import { revealedLines, tokenizeLine } from './code-block';

describe('tokenizeLine', () => {
  test('splits a ts line into keyword, plain, and string tokens', () => {
    expect(tokenizeLine("const name = 'dispatch';", 'ts')).toEqual([
      { text: 'const', kind: 'keyword' },
      { text: ' name = ', kind: 'plain' },
      { text: "'dispatch'", kind: 'string' },
      { text: ';', kind: 'plain' },
    ]);
  });

  test('marks a ts line comment as a single comment token', () => {
    expect(tokenizeLine('// retry once before failing', 'ts')).toEqual([
      { text: '// retry once before failing', kind: 'comment' },
    ]);
  });

  test('marks numeric literals in a ts line', () => {
    expect(tokenizeLine('const retries = 3;', 'ts')).toEqual([
      { text: 'const', kind: 'keyword' },
      { text: ' retries = ', kind: 'plain' },
      { text: '3', kind: 'number' },
      { text: ';', kind: 'plain' },
    ]);
  });

  test('tokenizes a css declaration: property plain, value string/number', () => {
    expect(tokenizeLine('  color: var(--accent);', 'css')).toEqual([
      { text: '  color: var(--accent);', kind: 'plain' },
    ]);
    expect(tokenizeLine('  padding: 12px;', 'css')).toEqual([
      { text: '  padding: ', kind: 'plain' },
      { text: '12px', kind: 'number' },
      { text: ';', kind: 'plain' },
    ]);
  });

  test('marks a css at-rule as a keyword token', () => {
    expect(tokenizeLine('@media (min-width: 768px) {', 'css')).toEqual([
      { text: '@media', kind: 'keyword' },
      { text: ' (min-width: ', kind: 'plain' },
      { text: '768px', kind: 'number' },
      { text: ') {', kind: 'plain' },
    ]);
  });

  test('tokenizes a json line into a string key and a keyword value', () => {
    expect(tokenizeLine('  "streaming": true,', 'json')).toEqual([
      { text: '  ', kind: 'plain' },
      { text: '"streaming"', kind: 'string' },
      { text: ': ', kind: 'plain' },
      { text: 'true', kind: 'keyword' },
      { text: ',', kind: 'plain' },
    ]);
  });

  test('returns a single plain token for an empty line', () => {
    expect(tokenizeLine('', 'ts')).toEqual([]);
  });

  test('does not treat // inside a string literal as a comment', () => {
    expect(tokenizeLine('const url = "http://example.com";', 'ts')).toEqual([
      { text: 'const', kind: 'keyword' },
      { text: ' url = ', kind: 'plain' },
      { text: '"http://example.com"', kind: 'string' },
      { text: ';', kind: 'plain' },
    ]);
  });

  test('does not match a keyword as a substring of a longer identifier', () => {
    expect(tokenizeLine('constants', 'ts')).toEqual([
      { text: 'constants', kind: 'plain' },
    ]);
    expect(tokenizeLine('myconstant', 'ts')).toEqual([
      { text: 'myconstant', kind: 'plain' },
    ]);
  });
});

describe('revealedLines', () => {
  const CODE = 'const a = 1;\nconst b = 2;\nconst c = 3;';

  test('reveals no lines until the first newline is streamed', () => {
    expect(revealedLines(CODE, 'const a')).toEqual([]);
  });

  test('reveals exactly the lines completed by a trailing newline', () => {
    expect(revealedLines(CODE, 'const a = 1;\n')).toEqual(['const a = 1;']);
    expect(revealedLines(CODE, 'const a = 1;\nconst b')).toEqual([
      'const a = 1;',
    ]);
  });

  test('reveals every line once shown catches up to the full code', () => {
    expect(revealedLines(CODE, CODE)).toEqual([
      'const a = 1;',
      'const b = 2;',
      'const c = 3;',
    ]);
  });

  test('treats shown longer than or equal to code as fully revealed', () => {
    expect(revealedLines(CODE, CODE)).toEqual(CODE.split('\n'));
  });
});
