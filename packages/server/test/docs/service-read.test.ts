import { describe, expect, it } from 'bun:test';

import { DocsError } from '../../src/docs/errors.js';
import { makeService, OWNER, TEAMMATE } from './fakeHost.js';

describe('read', () => {
  it('pages a body and a section with an outline, and 404s the invisible', () => {
    const { service } = makeService();
    const owner = service.actorFor(OWNER);
    const body = `# Big\n## Part\n${'line of text\n'.repeat(4000)}## Tail\nend\n`;
    service.create(owner, { title: 'Big', body });
    const page = service.read(owner, 'big', { page: true });
    expect(page.nextOffset).not.toBeNull();
    expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(32 * 1024);
    expect(page.outline.map((o) => o.anchor)).toEqual(['big', 'part', 'tail']);
    expect(service.read(owner, 'big', { section: 'Tail' }).text).toBe(
      '## Tail\nend\n'
    );
    expect(service.read(owner, 'big').text).toBe(body);
    let missing: unknown = null;
    try {
      service.read(owner, 'nope');
    } catch (err) {
      missing = err;
    }
    expect((missing as DocsError).code).toBe('not-found');
    expect(() => service.read(owner, '~mine')).toThrow('not found');
  });
});

describe('search', () => {
  for (const fts of [true, false]) {
    it(`groups section hits by doc, at most three each (${fts ? 'FTS5' : 'LIKE fallback'})`, () => {
      const { service } = makeService({ fts });
      const owner = service.actorFor(OWNER);
      service.create(owner, {
        title: 'Tokens',
        body: '# Tokens\ntoken one\n## A\ntoken a\n## B\ntoken b\n## C\ntoken c\n',
      });
      service.create(owner, {
        title: 'Other',
        body: '# Other\nno match\n## D\na token here\n',
      });
      service.sweep();
      const hits = service.search(service.actorFor(TEAMMATE), {
        query: 'token',
      });
      const perDoc = new Map<string, number>();
      for (const h of hits)
        perDoc.set(h.handle, (perDoc.get(h.handle) ?? 0) + 1);
      expect(perDoc.get('tokens')).toBe(3);
      expect(perDoc.get('other')).toBe(1);
      expect(() => service.search(owner, { query: 'x'.repeat(501) })).toThrow(
        'query'
      );
    });

    it(`refuses a query with a NUL or an unpaired surrogate as invalid (${fts ? 'FTS5' : 'LIKE fallback'})`, () => {
      const { service } = makeService({ fts });
      const owner = service.actorFor(OWNER);
      service.create(owner, {
        title: 'Hello',
        body: '# Hello\nhello \ud83d\ude00\n',
      });
      service.sweep();
      for (const query of ['x\u0000', 'hello\ud800', '\udc00hello']) {
        let failure: unknown = null;
        try {
          service.search(owner, { query });
        } catch (err) {
          failure = err;
        }
        expect(failure).toBeInstanceOf(DocsError);
        expect(failure).toMatchObject({ code: 'invalid', field: 'query' });
      }
      expect(
        service.search(owner, { query: 'hello 😀' }).length
      ).toBeGreaterThan(0);
    });
  }
});

describe('health', () => {
  it('reports the search mode to humans and refuses runs', () => {
    const { service } = makeService({ fts: false });
    expect(service.health(service.actorFor(OWNER))).toMatchObject({
      available: true,
      search: 'like',
    });
    expect(() =>
      service.health(
        service.actorFor({ address: 'run:r-1', canDecide: false, kind: 'run' })
      )
    ).toThrow('health is for humans');
  });

  it('adds the orphan list for decide tier only', () => {
    const { service } = makeService({
      orphans: ['/home/x/.dispatch/runs/abc123def456/docs.db'],
    });
    expect(service.health(service.actorFor(OWNER)).orphans).toEqual([
      '/home/x/.dispatch/runs/abc123def456/docs.db',
    ]);
    expect(
      service.health(
        service.actorFor({
          address: 'human:alice',
          canDecide: false,
          kind: 'human',
        })
      ).orphans
    ).toBeUndefined();
  });
});
