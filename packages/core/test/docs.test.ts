import { describe, expect, it } from 'bun:test';

import {
  docBodyProblem,
  DOCS_LIMITS,
  docSlug,
  docSlugProblem,
  docTitleProblem,
  jsonEscapedBytes,
  normalizeDocText,
  RESERVED_DOC_SLUGS,
} from '../src/docs.js';

describe('normalizeDocText', () => {
  it('turns CRLF and lone CR into LF and strips a leading BOM', () => {
    expect(normalizeDocText('\uFEFFa\r\nb\rc\n')).toBe('a\nb\nc\n');
    expect(normalizeDocText('x\uFEFF')).toBe('x\uFEFF');
  });
});

describe('docSlug', () => {
  it('keeps dated names and cuts at 64 on a dash', () => {
    expect(docSlug('2026-09-25 Memory design')).toBe(
      '2026-09-25-memory-design'
    );
    const long = docSlug(
      'A very long title that keeps going well past the sixty four character limit for slugs'
    );
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.endsWith('-')).toBe(false);
    expect(long).toBe(
      'a-very-long-title-that-keeps-going-well-past-the-sixty-four'
    );
  });

  it('never derives an id prefix, a reserved word or an empty slug', () => {
    expect(docSlug('Doc overview')).toBe('the-doc-overview');
    expect(docSlug('Rev 2 notes')).toBe('the-rev-2-notes');
    expect(docSlug('Search')).toBe('the-search');
    expect(docSlug('日本語')).toBe('untitled');
    for (const title of ['Doc overview', 'Search', '日本語', 'x'.repeat(100)])
      expect(docSlugProblem(docSlug(title))).toBeNull();
  });

  it('checks the cut slug, so a long hash after a route word cannot strip it bare', () => {
    const hash = 'x'.repeat(64);
    for (const word of RESERVED_DOC_SLUGS)
      expect(docSlug(`${word} ${hash}`)).toBe(`the-${word}`);
    for (const title of [
      `Doc ${hash}`,
      `Rev ${hash}`,
      `Doc ${'a'.repeat(58)} ${'b'.repeat(10)}`,
      `Search ${'x'.repeat(70)}`,
    ]) {
      const slug = docSlug(title);
      expect(docSlugProblem(slug)).toBeNull();
    }
  });
});

describe('input checks', () => {
  it('holds titles to one line of 1-200 bytes', () => {
    expect(docTitleProblem('Auth')).toBeNull();
    expect(docTitleProblem('   ')).toBe('title must not be empty');
    expect(docTitleProblem('a\u2028b')).toBe('title must be one line');
    expect(docTitleProblem('é'.repeat(100))).toBeNull();
    expect(docTitleProblem('é'.repeat(101))).toBe(
      'title must be at most 200 bytes (UTF-8)'
    );
    expect(docTitleProblem(3)).toBe('title must be a string');
  });

  it('refuses NUL and control characters in titles but keeps tabs', () => {
    for (const title of ['a\u0000b', 'a\u001b[31mb', 'a\u007fb', 'a\u009bb'])
      expect(docTitleProblem(title)).toBe(
        'title must not contain control characters'
      );
    expect(docTitleProblem('a\tb')).toBeNull();
  });

  it('holds slugs to the grammar and away from ids and route words', () => {
    expect(docSlugProblem('auth-refactor')).toBeNull();
    expect(docSlugProblem('Auth')).toContain('[a-z0-9-]');
    expect(docSlugProblem('-auth')).toContain('start with a letter or digit');
    expect(docSlugProblem('doc-1')).toContain('doc-');
    expect(docSlugProblem('rev-1')).toContain('rev-');
    expect(docSlugProblem('health')).toContain('reserved');
    expect(docSlugProblem('a'.repeat(65))).toContain('64');
  });

  it('holds bodies to 768 KiB, no NUL, and 960 KiB once JSON-escaped', () => {
    expect(docBodyProblem('ok')).toBeNull();
    expect(docBodyProblem('a\u0000b')).toBe('body must not contain NUL');
    expect(docBodyProblem('x'.repeat(DOCS_LIMITS.bodyBytes))).toBeNull();
    expect(docBodyProblem('x'.repeat(DOCS_LIMITS.bodyBytes + 1))).toBe(
      'body is over 768 KiB; split it into linked docs'
    );
    const quotes = '"'.repeat(500_000);
    expect(jsonEscapedBytes(quotes)).toBe(1_000_000);
    expect(docBodyProblem(quotes)).toBe(
      'body is over 960 KiB once JSON-escaped; split it into linked docs'
    );
  });
});
