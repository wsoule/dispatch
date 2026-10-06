import { describe, expect, it } from 'bun:test';

import { DocsError } from '../../src/docs/errors.js';
import { makeService, OWNER, RUN, TEAMMATE } from './fakeHost.js';

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

  it('gives each outline heading its line, skipping headings in fenced code', () => {
    const { service } = makeService();
    const owner = service.actorFor(OWNER);
    const body = [
      '# Doc',
      '- ```md',
      '  ## API',
      '  ```',
      '## API',
      '``` a`b',
      '## API',
      '',
    ].join('\n');
    service.create(owner, { title: 'Fences', body });
    const read = service.read(owner, 'fences');
    expect(read.outline.map((o) => [o.anchor, o.line])).toEqual([
      ['doc', 0],
      ['api', 4],
      ['api-1', 6],
    ]);
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

describe('doc_list from a run', () => {
  it("lists the run's own task's docs when it names no task", () => {
    const { service } = makeService();
    service.create(service.actorFor(OWNER), {
      title: 'Spec',
      body: 'x\n',
      links: [{ target: { type: 'task', id: 't-1' }, rel: 'spec' }],
    });
    service.create(service.actorFor(OWNER), {
      title: 'Unrelated',
      body: 'x\n',
    });
    const run = service.actorFor(RUN);
    expect(service.list(run, {}).docs.map((d) => [d.handle, d.rel])).toEqual([
      ['spec', 'spec'],
    ]);
    expect(
      service.list(run, { query: 'related' }).docs.map((d) => d.handle)
    ).toEqual(['unrelated']);
  });
});

describe('specLine', () => {
  it("renders only the task's own team spec as the spec line", () => {
    const { service, host } = makeService();
    host.operators.set('human:wyat', {
      human: 'human:wyat',
      identity: 'id-wyat',
    });
    const owner = service.actorFor(OWNER);
    service.create(owner, {
      title: 'Epic spec',
      body: 'x\n',
      links: [{ target: { type: 'task', id: 'e-1' }, rel: 'spec' }],
    });
    expect(service.specLine('t-1')).toBeNull();
    // A personal spec is its owner's alone: it never reaches a review prompt.
    service.create(owner, {
      title: 'Private spec',
      body: 'p\n',
      scope: 'personal',
      links: [{ target: { type: 'task', id: 't-1' }, rel: 'spec' }],
    });
    expect(service.specLine('t-1')).toBeNull();
    service.create(owner, {
      title: 'Own',
      body: 'y\n',
      links: [{ target: { type: 'task', id: 't-1' }, rel: 'spec' }],
    });
    expect(service.specLine('t-1')).toBe(
      '- spec · own · draft · rev 1 · 1 KB: Own: y'
    );
  });

  it('answers null while docs are unavailable', () => {
    const { service } = makeService();
    service.close();
    expect(service.specLine('t-1')).toBeNull();
  });
});
