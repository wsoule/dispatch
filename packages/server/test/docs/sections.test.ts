import { describe, expect, it } from 'bun:test';

import { DOCS_ERROR_STATUS, DocsError } from '../../src/docs/errors.js';
import {
  cutUtf8,
  fencedLines,
  mentionsOf,
  outline,
  pageOf,
  resolveSection,
  sectionText,
  splitLines,
  summaryOf,
  utf8Bytes,
} from '../../src/docs/sections.js';

const DOC = [
  'Intro line.',
  '',
  '# Title',
  'Top text.',
  '## API',
  'Endpoints.',
  '### Errors',
  'Codes.',
  '#### Deep heading is text',
  '## API',
  'Second API.',
  '```ts',
  '## not a heading',
  '```',
  '~~~~',
  '# also not',
  '~~~',
  'still fenced',
  '~~~~',
  '## Risks ##',
  'Last.',
].join('\n');

describe('splitLines', () => {
  it('keeps each newline and leaves a missing final one missing', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\nb')).toEqual(['a\n', 'b']);
    expect(splitLines('a\n')).toEqual(['a\n']);
    expect(splitLines('\n\n')).toEqual(['\n', '\n']);
  });
});

describe('outline', () => {
  const sections = outline(DOC);

  it('lists the preamble and ATX h1-h3 outside fences only', () => {
    expect(sections.map((s) => [s.ord, s.level, s.heading])).toEqual([
      [0, 0, ''],
      [1, 1, 'Title'],
      [2, 2, 'API'],
      [3, 3, 'Errors'],
      [4, 2, 'API'],
      [5, 2, 'Risks'],
    ]);
  });

  it('gives duplicate headings GitHub-style anchors', () => {
    expect(sections.map((s) => s.anchor)).toEqual([
      '',
      'title',
      'api',
      'errors',
      'api-1',
      'risks',
    ]);
  });

  it('runs a section to the next heading of the same or a higher level', () => {
    const lines = splitLines(DOC);
    const api = sections[2];
    expect(sectionText(lines, api)).toBe(
      '## API\nEndpoints.\n### Errors\nCodes.\n#### Deep heading is text\n'
    );
    expect(sectionText(lines, api, true)).toBe('## API\nEndpoints.\n');
    expect(sectionText(lines, sections[1])).toBe(lines.slice(2).join(''));
  });

  it('treats setext headings and headings with no space as text', () => {
    expect(outline('Title\n=====\n#NoSpace\n').map((s) => s.level)).toEqual([
      0,
    ]);
  });

  it('closes a fence only with a run at least as long, and an unclosed fence runs to the end', () => {
    expect(
      outline('````\n```\n# inside\n````\n# out\n').map((s) => s.heading)
    ).toEqual(['', 'out']);
    expect(outline('```\n# inside\n').map((s) => s.heading)).toEqual(['']);
  });

  it('keeps unicode letters in anchors and drops punctuation', () => {
    expect(
      outline('## Überblick: Plan (v2)!\n## naïve café\n').map((s) => s.anchor)
    ).toEqual(['', 'überblick-plan-v2', 'naïve-café']);
  });
});

describe('resolveSection', () => {
  const sections = outline(DOC);

  it('finds a section by heading text, by its written form and by anchor', () => {
    expect(resolveSection(sections, 'Errors', 'section').ord).toBe(3);
    expect(resolveSection(sections, '### Errors', 'section').ord).toBe(3);
    expect(resolveSection(sections, '#api-1', 'section').ord).toBe(4);
  });

  it('names the candidates when heading text is ambiguous', () => {
    expect(() => resolveSection(sections, 'API', 'ops[0]')).toThrow(
      'ops[0]: ambiguous: #api, #api-1'
    );
  });

  it('refuses a missing section and never matches the preamble', () => {
    const err = (() => {
      try {
        resolveSection(sections, 'Nope', 'section');
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(DocsError);
    expect((err as DocsError).field).toBe('section');
    expect(() => resolveSection(sections, '', 'section')).toThrow('not found');
  });
});

describe('mentionsOf', () => {
  it('finds [[slug]], [[slug#anchor]] and [[~slug]] outside fenced code, once each', () => {
    const body =
      'See [[auth-refactor]] and [[auth-refactor#api]].\n```\n[[in-code]]\n```\nMine: [[~notes]] [[Bad Slug]]\n';
    expect(mentionsOf(body)).toEqual([
      { personal: false, slug: 'auth-refactor', anchor: null },
      { personal: true, slug: 'notes', anchor: null },
    ]);
  });
});

describe('summaryOf', () => {
  it('takes the first paragraph that is not a heading or code, cut to 120 bytes', () => {
    expect(
      summaryOf(
        '# Title\n\n```\ncode\n```\nFirst line\nsecond line.\n\nNext para.\n'
      )
    ).toBe('First line second line.');
    const long = `# T\n${'é'.repeat(100)}\n`;
    const cut = summaryOf(long);
    expect(new TextEncoder().encode(cut).byteLength).toBeLessThanOrEqual(120);
    expect(cut).toBe('é'.repeat(60));
  });

  it('is empty for a doc of headings only', () => {
    expect(summaryOf('# A\n## B\n')).toBe('');
  });
});

describe('DOCS_ERROR_STATUS', () => {
  it('maps each error code to its HTTP status', () => {
    expect(DOCS_ERROR_STATUS).toEqual({
      invalid: 400,
      forbidden: 403,
      'not-found': 404,
      conflict: 409,
      limited: 429,
      unavailable: 503,
    });
  });
});

describe('fencedLines', () => {
  it('marks fence lines and the code between them, and nothing after the close', () => {
    expect(fencedLines(splitLines('a\n```\n# x\n```\nb\n'))).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
  });
});

describe('utf8Bytes', () => {
  it('counts UTF-8 bytes, not UTF-16 units', () => {
    expect(utf8Bytes('')).toBe(0);
    expect(utf8Bytes('é')).toBe(2);
    expect(utf8Bytes('😀')).toBe(4);
  });
});

describe('cutUtf8', () => {
  it('never splits a code point', () => {
    expect(cutUtf8('ab😀cd', 5)).toBe('ab');
    expect(cutUtf8('ab😀cd', 6)).toBe('ab😀');
  });
});

describe('pageOf', () => {
  it('ends a page on a line boundary and gives the next offset', () => {
    const text = 'aaaa\nbbbb\ncccc\n';
    expect(pageOf(text, 0, 12)).toEqual({
      text: 'aaaa\nbbbb\n',
      offset: 0,
      nextOffset: 10,
      total: 15,
    });
    expect(pageOf(text, 10, 12)).toEqual({
      text: 'cccc\n',
      offset: 10,
      nextOffset: null,
      total: 15,
    });
  });

  it('review focus 2: pages a single line longer than a page on character boundaries', () => {
    const line = 'é'.repeat(40_000); // 80,000 bytes, no newline
    const pages: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = pageOf(line, offset, 32 * 1024);
      expect(
        new TextEncoder().encode(page.text).byteLength
      ).toBeLessThanOrEqual(32 * 1024);
      expect(page.text.includes('�')).toBe(false);
      pages.push(page.text);
      offset = page.nextOffset;
    }
    expect(pages.length).toBe(3);
    expect(pages.join('')).toBe(line);
  });

  it('refuses an offset outside the text or inside a character', () => {
    expect(() => pageOf('é', 1, 10)).toThrow('offset');
    expect(() => pageOf('abc', 4, 10)).toThrow('offset');
    expect(() => pageOf('abc', -1, 10)).toThrow('offset');
  });
});
