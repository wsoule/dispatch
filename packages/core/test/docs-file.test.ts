import { describe, expect, it } from 'bun:test';

import type { DocFileMeta } from '../src/docs.js';
import { parseDocFile, renderDocFile } from '../src/docs.js';

const META: DocFileMeta = {
  id: 'doc-01K',
  slug: 'auth',
  title: 'Auth: "the" plan',
  status: 'draft',
  rev: 'rev-01K',
  n: 3,
  parents: ['rev-01J'],
  author: 'human:wyat',
  cause: 'save',
  createdAt: '2026-09-26T10:00:00.000Z',
  hash: 'abc',
  links: [{ target: 'task:t-1', rel: 'spec' }],
  authors: ['human:wyat', 'run:r-1'],
  updatedAt: '2026-09-26T11:00:00.000Z',
};

describe('the receipt file format', () => {
  it('round-trips JSON-scalar frontmatter and the body exactly', () => {
    const body = '---\n# Auth\n\nkey: value\n';
    const text = renderDocFile(META, body);
    expect(text.startsWith('---\nid: "doc-01K"\n')).toBe(true);
    expect(parseDocFile(text)).toEqual({ meta: META, body });
  });

  it('round-trips a title with line separators and an empty body', () => {
    const meta = { ...META, title: 'a b' };
    expect(parseDocFile(renderDocFile(meta, ''))).toEqual({ meta, body: '' });
  });

  it('refuses a file without frontmatter or with a bad field', () => {
    expect(parseDocFile('# no frontmatter\n')).toEqual({
      error: 'no frontmatter',
    });
    expect(
      parseDocFile(renderDocFile(META, 'x').replace('n: 3', 'n: "three"'))
    ).toEqual({ error: 'n must be a number' });
    expect(
      parseDocFile(renderDocFile(META, 'x').replace('links: [', 'links: {'))
    ).toEqual({ error: 'links is not JSON' });
    expect(
      parseDocFile(renderDocFile(META, 'x').replace('\n---\nx', '\nx'))
    ).toEqual({ error: 'unterminated frontmatter' });
  });

  it('refuses values outside their sets and arrays of the wrong shape', () => {
    const bad = (meta: Record<string, unknown>) =>
      parseDocFile(
        renderDocFile({ ...META, ...meta } as unknown as DocFileMeta, 'x')
      );
    expect(bad({ status: 'bogus' })).toEqual({
      error: 'status must be draft, accepted or archived',
    });
    expect(bad({ cause: 'hack' })).toEqual({
      error: 'cause is not a revision cause',
    });
    expect(bad({ parents: [5] })).toEqual({
      error: 'parents must hold strings',
    });
    expect(bad({ authors: [null] })).toEqual({
      error: 'authors must hold strings',
    });
    expect(bad({ links: [5] })).toEqual({
      error: 'links must hold { target, rel } with rel spec, plan or context',
    });
    expect(bad({ links: [{ target: 'task:t-1', rel: 'owner' }] })).toEqual({
      error: 'links must hold { target, rel } with rel spec, plan or context',
    });
    expect(bad({ n: 1.5 })).toEqual({ error: 'n must be a whole number' });
  });
});
