import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';

import type { DocsError } from '../../src/docs/errors.js';
import type { ImportFile, ImportText } from '../../src/docs/transfer.js';
import {
  importTitle,
  nameSlug,
  planImport,
  splitForCap,
} from '../../src/docs/transfer.js';
import { DECIDER, makeService, OWNER, TEAMMATE } from './fakeHost.js';

const sha = (s: string | Uint8Array) =>
  createHash('sha256').update(s).digest('hex');
const enc = (s: string) => new TextEncoder().encode(s);

function file(
  path: string,
  text: string,
  mtime: string
): { meta: ImportFile; bytes: Uint8Array } {
  const bytes = enc(text);
  const name = path.split('/').at(-1) ?? path;
  return {
    meta: { path, name, mtime, bytes: bytes.byteLength, hash: sha(bytes) },
    bytes,
  };
}

function bigDoc(sections: number, lineBytes: number): string {
  const out = ['# Big plan\n'];
  for (let s = 0; s < sections; s++) {
    out.push(`## Section ${s}\n`);
    for (let l = 0; l < 20; l++)
      out.push(`${'x'.repeat(lineBytes)} ${s}.${l}\n`);
  }
  return out.join('');
}

describe('pure planning', () => {
  it('keeps dated names as slugs and titles from the first # heading', () => {
    expect(nameSlug('2026-09-25-memory-design.md')).toBe(
      '2026-09-25-memory-design'
    );
    expect(importTitle('```\n# not me\n```\n# Memory design\n', 'x')).toBe(
      'Memory design'
    );
    expect(importTitle('no heading\n', 'fallback-slug')).toBe('fallback-slug');
  });

  it('holds a title to 200 bytes and falls back on a control character', () => {
    expect(
      new TextEncoder().encode(importTitle(`# ${'é'.repeat(150)}\n`, 's'))
        .byteLength
    ).toBe(200);
    expect(importTitle('# bell \u0007 here\n', 'fallback')).toBe('fallback');
  });

  it('splits over-cap text before the last ## heading that fits, adding nothing', () => {
    const text = bigDoc(80, 600);
    const parts = splitForCap(text);
    expect(parts.length).toBe(2);
    expect(parts.join('')).toBe(text);
    expect(parts[1].startsWith('## Section ')).toBe(true);
    for (const p of parts)
      expect(new TextEncoder().encode(p).byteLength).toBeLessThanOrEqual(
        768 * 1024
      );
  });

  it('falls back to ###, then a blank line, then any line break', () => {
    const noHeadings = `${'y'.repeat(1000)}\n`.repeat(900);
    const parts = splitForCap(noHeadings);
    expect(parts.join('')).toBe(noHeadings);
    expect(parts.every((p) => p.endsWith('\n'))).toBe(true);
  });

  it('cuts a single line longer than the cap on a code point', () => {
    const line = `${'é'.repeat(500_000)}\n`;
    const parts = splitForCap(line);
    expect(parts.join('')).toBe(line);
    expect(parts.length).toBe(2);
    for (const p of parts)
      expect(new TextEncoder().encode(p).byteLength).toBeLessThanOrEqual(
        768 * 1024
      );
  });

  it('holds both identities over identical and drifted copies', () => {
    const x = file(
      'main/.agents/ignore/specs/x.md',
      '# X\nv1\n',
      '2026-09-20T00:00:00.000Z'
    );
    const xCopy = file(
      'wt-a/.agents/ignore/specs/x.md',
      '# X\nv1\n',
      '2026-09-21T00:00:00.000Z'
    );
    const xDrift = file(
      'wt-b/.agents/ignore/specs/x.md',
      '# X\nv2\n',
      '2026-09-22T00:00:00.000Z'
    );
    const y = file(
      'main/.agents/ignore/plans/y.md',
      '# Y\n',
      '2026-09-20T00:00:00.000Z'
    );
    const texts = new Map<string, ImportText>(
      [x, xDrift, y].map((f) => [
        f.meta.hash,
        { text: new TextDecoder().decode(f.bytes) },
      ])
    );
    const { names, report } = planImport(
      [x.meta, xCopy.meta, xDrift.meta, y.meta],
      texts,
      {
        imported: () => false,
        tombstoned: () => false,
        exists: () => false,
        partExists: () => false,
      }
    );
    expect(report).toMatchObject({
      files: 4,
      names: 2,
      distinctContents: 3,
      contentsImported: 3,
      duplicates: 1,
      docsCreated: 2,
      parity: { files: true, names: true },
    });
    const xPlan = names.find((n) => n.slug === 'x');
    expect(xPlan?.contents.map((c) => c.hash)).toEqual([
      x.meta.hash,
      xDrift.meta.hash,
    ]);
  });
});

describe('the staged import', () => {
  function stage(
    service: ReturnType<typeof makeService>['service'],
    files: { meta: ImportFile; bytes: Uint8Array }[],
    dryRun = false
  ) {
    const owner = service.actorFor(OWNER);
    const { id, need } = service.openImport(owner, {
      files: files.map((f) => f.meta),
      link: null,
    });
    for (const hash of need) {
      const f = files.find((g) => g.meta.hash === hash);
      if (f !== undefined) service.putImportContent(owner, id, hash, f.bytes);
    }
    return { id, report: service.commitImport(owner, id, dryRun) };
  }

  it('imports more than 2 MiB across uploads, drifted copies as revisions, newest as head', () => {
    const { service } = makeService();
    const big = ['a', 'b', 'c'].map((n, i) =>
      file(
        `p/${n}.md`,
        `# ${n}\n${'z'.repeat(750 * 1024)}\n`,
        `2026-09-2${i}T00:00:00.000Z`
      )
    );
    const drift = [
      file('p/d.md', '# D\nold\n', '2026-09-20T00:00:00.000Z'),
      file('q/d.md', '# D\nnew\n', '2026-09-21T00:00:00.000Z'),
    ];
    const { report } = stage(service, [...big, ...drift]);
    expect(report).toMatchObject({
      files: 5,
      names: 4,
      docsCreated: 4,
      contentsImported: 5,
      revisionsCreated: 5,
      parity: { files: true, names: true },
    });
    const owner = service.actorFor(OWNER);
    expect(service.read(owner, 'd').text).toBe('# D\nnew\n');
    expect(
      service.revisions(owner, 'd', {}).map((r) => [r.n, r.cause, r.createdAt])
    ).toEqual([
      [2, 'import', '2026-09-21T00:00:00.000Z'],
      [1, 'import', '2026-09-20T00:00:00.000Z'],
    ]);
  });

  it('splits an over-cap file into linked part docs and re-imports it as already present', () => {
    const { service } = makeService();
    const text = bigDoc(80, 600);
    const plan = file(
      'p/2026-09-25-a2a-bridge.md',
      text,
      '2026-09-25T00:00:00.000Z'
    );
    const first = stage(service, [plan]).report;
    expect(first).toMatchObject({
      docsCreated: 1,
      partDocsCreated: 1,
      splitContents: 1,
      contentsImported: 1,
      parity: { files: true, names: true },
    });
    const owner = service.actorFor(OWNER);
    const part2 = service.read(owner, '2026-09-25-a2a-bridge-part-2');
    expect(part2.doc.title).toBe('Big plan (part 2 of 2)');
    expect(part2.links.map((l) => l.target.type)).toEqual(['doc']);
    const again = stage(service, [plan]).report;
    expect(again).toMatchObject({
      alreadyPresent: 1,
      contentsImported: 0,
      docsExisting: 1,
      revisionsCreated: 0,
      parity: { files: true, names: true },
    });
  });

  it('reports too-large, missing and non-UTF-8 files by name and imports the rest', () => {
    const { service } = makeService();
    const owner = service.actorFor(OWNER);
    const good = file('p/good.md', '# Good\n', '2026-09-20T00:00:00.000Z');
    const huge = {
      meta: {
        path: 'p/huge.md',
        name: 'huge.md',
        mtime: '2026-09-20T00:00:00.000Z',
        bytes: 9 * 1024 * 1024,
        hash: sha('huge'),
      },
      bytes: enc(''),
    };
    const latin1 = {
      meta: {
        path: 'p/latin.md',
        name: 'latin.md',
        mtime: '2026-09-20T00:00:00.000Z',
        bytes: 2,
        hash: sha(new Uint8Array([0xe9, 0x0a])),
      },
      bytes: new Uint8Array([0xe9, 0x0a]),
    };
    const lost = file('p/lost.md', '# Lost\n', '2026-09-20T00:00:00.000Z');
    const { id, need } = service.openImport(owner, {
      files: [good.meta, huge.meta, latin1.meta, lost.meta],
      link: null,
    });
    expect(need).not.toContain(huge.meta.hash);
    service.putImportContent(owner, id, good.meta.hash, good.bytes);
    service.putImportContent(owner, id, latin1.meta.hash, latin1.bytes);
    const report = service.commitImport(owner, id, false);
    expect(report.errors.map((e) => [e.path, e.reason])).toEqual([
      ['p/huge.md', 'too-large'],
      ['p/latin.md', 'not UTF-8'],
      ['p/lost.md', 'missing'],
    ]);
    expect(report).toMatchObject({
      failedNames: 3,
      docsCreated: 1,
      parity: { files: true, names: true },
    });
  });

  it('checks each upload against its hash and the manifest', () => {
    const { service } = makeService();
    const owner = service.actorFor(OWNER);
    const good = file('p/good.md', '# Good\n', '2026-09-20T00:00:00.000Z');
    const { id } = service.openImport(owner, {
      files: [good.meta],
      link: null,
    });
    expect(() =>
      service.putImportContent(owner, id, good.meta.hash, enc('tampered'))
    ).toThrow('does not match');
    expect(() =>
      service.putImportContent(owner, id, sha('other'), enc('other'))
    ).toThrow('not in this import');
  });

  it('needs a decide-tier human', () => {
    const { service } = makeService();
    const code = (() => {
      try {
        service.openImport(service.actorFor(TEAMMATE), {
          files: [],
          link: null,
        });
      } catch (err) {
        return (err as DocsError).code;
      }
      return 'ok';
    })();
    expect(code).toBe('forbidden');
    expect(
      service.openImport(service.actorFor(DECIDER), { files: [], link: null })
        .need
    ).toEqual([]);
  });

  it('replaces the same human’s open session', () => {
    const { service } = makeService();
    const owner = service.actorFor(OWNER);
    const first = service.openImport(owner, { files: [], link: null }).id;
    service.openImport(owner, { files: [], link: null });
    expect(() => service.commitImport(owner, first, true)).toThrow(
      'import session'
    );
  });

  it('writes nothing on a dry run', () => {
    const { service } = makeService();
    const { report } = stage(
      service,
      [file('p/x.md', '# X\n', '2026-09-20T00:00:00.000Z')],
      true
    );
    expect(report).toMatchObject({
      dryRun: true,
      docsCreated: 1,
      revisionsCreated: 1,
    });
    expect(service.list(service.actorFor(OWNER), {}).total).toBe(0);
  });

  it('links every imported doc as context and keeps an existing rel', () => {
    const { service } = makeService();
    const owner = service.actorFor(OWNER);
    const linked = (f: { meta: ImportFile; bytes: Uint8Array }) => {
      const { id } = service.openImport(owner, {
        files: [f.meta],
        link: { type: 'task', id: 't-1' },
      });
      service.putImportContent(owner, id, f.meta.hash, f.bytes);
      return service.commitImport(owner, id, false);
    };
    linked(file('p/x.md', '# X\n', '2026-09-20T00:00:00.000Z'));
    const rels = () =>
      service.read(owner, 'x').links.map((l) => [l.target.id, l.rel]);
    expect(rels()).toEqual([['t-1', 'context']]);
    service.link(owner, 'x', {
      target: { type: 'task', id: 't-1' },
      rel: 'spec',
    });
    const again = linked(
      file('p/x.md', '# X\nv2\n', '2026-09-21T00:00:00.000Z')
    );
    expect(again).toMatchObject({ docsExisting: 1, contentsImported: 1 });
    expect(rels()).toEqual([['t-1', 'spec']]);
  });

  it('seals an open head before a re-import builds on it', () => {
    const { service, store, host } = makeService();
    const owner = service.actorFor(OWNER);
    stage(service, [file('p/x.md', '# X\nv1\n', '2026-09-20T00:00:00.000Z')]);
    const head = service.read(owner, 'x').rev;
    const saved = service.saveBody(owner, 'x', {
      baseRev: head.id,
      baseHash: head.hash,
      body: '# X\nsaved\n',
    });
    expect(store.openHeads().map((r) => r.id)).toEqual([saved.rev.id]);
    stage(service, [file('q/x.md', '# X\nv2\n', '2026-09-21T00:00:00.000Z')]);
    expect(
      service.revisions(owner, 'x', {}).map((r) => [r.n, r.cause, r.sealed])
    ).toEqual([
      [3, 'import', true],
      [2, 'save', true],
      [1, 'import', true],
    ]);
    expect(store.openHeads()).toEqual([]);
    expect(
      host.changes.some((c) => c.kind === 'sealed' && c.rev === saved.rev.id)
    ).toBe(true);
  });

  it('skips a tombstoned origin on re-import', () => {
    const { service } = makeService();
    const x = file('p/x.md', '# X\n', '2026-09-20T00:00:00.000Z');
    stage(service, [x]);
    service.remove(service.actorFor(OWNER), 'x');
    const again = stage(service, [
      file('p/x.md', '# X\nnewer\n', '2026-09-21T00:00:00.000Z'),
    ]).report;
    expect(again).toMatchObject({
      tombstoned: 1,
      tombstonedNames: 1,
      docsCreated: 0,
      parity: { files: true, names: true },
    });
  });

  it('drops a session idle for 24 hours from the sweep', () => {
    const { service, host } = makeService();
    const { id } = service.openImport(service.actorFor(OWNER), {
      files: [],
      link: null,
    });
    host.advance(24 * 60 + 1);
    service.sweep();
    expect(() =>
      service.commitImport(service.actorFor(OWNER), id, true)
    ).toThrow('import session');
  });
});
