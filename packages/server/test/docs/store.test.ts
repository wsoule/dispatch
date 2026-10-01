import { dbVersion, openSqliteDb } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DocRow, RevisionRow, SectionRow } from '../../src/docs/store.js';
import {
  DOCS_DB_VERSION,
  openDocsDb,
  SqliteDocStore,
} from '../../src/docs/store.js';

const AT = '2026-09-26T10:00:00.000Z';

function docRow(over: Partial<DocRow> = {}): DocRow {
  return {
    id: 'doc-01',
    ns: 'team',
    slug: 'auth',
    handle: 'auth',
    title: 'Auth',
    scope: 'team',
    ownerIdentity: null,
    ownerHuman: null,
    status: 'draft',
    archivedFrom: null,
    restoredStatus: null,
    restoredAt: null,
    headId: 'rev-01',
    reviewedRev: null,
    unreviewed: false,
    conflicted: false,
    origin: null,
    publishedPath: null,
    publishedRev: null,
    publishedTask: null,
    publishedCommit: null,
    createdBy: 'human:wyat',
    createdAt: AT,
    updatedBy: 'human:wyat',
    updatedAt: AT,
    indexedHash: null,
    ...over,
  };
}

function revRow(over: Partial<RevisionRow> = {}): RevisionRow {
  return {
    id: 'rev-01',
    docId: 'doc-01',
    n: 1,
    parents: [],
    restoredParents: null,
    title: 'Auth',
    body: '# Auth\n',
    hash: 'h1',
    bytes: 7,
    author: 'human:wyat',
    cause: 'create',
    summary: 'created',
    approval: null,
    conflicted: false,
    sealed: false,
    unreviewed: false,
    provisional: false,
    via: null,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

function section(ord: number, heading: string, text: string): SectionRow {
  return {
    ord,
    level: ord === 0 ? 0 : 2,
    heading,
    anchor: heading.toLowerCase(),
    startByte: 0,
    endByte: text.length,
    text,
  };
}

let store: SqliteDocStore;
beforeEach(() => {
  const { db, fts } = openDocsDb(':memory:');
  store = new SqliteDocStore(db, fts);
});
afterEach(() => store.close());

describe('openDocsDb', () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'docs-db-')));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('stamps the schema version and sets a busy timeout', () => {
    const { db } = openDocsDb(join(dir, 'docs.db'));
    expect(dbVersion(db)).toBe(DOCS_DB_VERSION);
    const timeout = db.prepare('PRAGMA busy_timeout').get() as {
      timeout: number;
    };
    expect(timeout.timeout).toBe(5000);
    db.close();
  });

  it('refuses a file a newer build stamped', () => {
    const path = join(dir, 'docs.db');
    const raw = openSqliteDb(path);
    raw.exec('PRAGMA user_version = 2');
    raw.close();
    expect(() => openDocsDb(path)).toThrow(
      'written by a newer schema (version 2, this build understands 1)'
    );
  });

  it('opens in fallback mode when FTS5 is not wanted or not there', () => {
    const { db, fts } = openDocsDb(join(dir, 'fallback.db'), { fts: false });
    expect(fts).toBe(false);
    db.close();
  });
});

describe('SqliteDocStore', () => {
  it('rolls a failed transaction back whole', () => {
    expect(() =>
      store.transaction(() => {
        store.putDoc(docRow());
        store.insertRevision(revRow());
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect(store.doc('doc-01')).toBeNull();
    expect(store.revision('rev-01')).toBeNull();
  });

  it('nests transactions and commits once', () => {
    store.transaction(() => {
      store.putDoc(docRow());
      store.transaction(() => store.insertRevision(revRow()));
    });
    expect(store.doc('doc-01')?.headId).toBe('rev-01');
    expect(store.revision('rev-01')?.body).toBe('# Auth\n');
  });

  it('round-trips revisions, amends and seals them, and numbers them per doc', () => {
    store.transaction(() => {
      store.putDoc(docRow());
      store.insertRevision(revRow());
    });
    store.amendRevision('rev-01', {
      title: 'Auth v2',
      body: '# Auth\nmore\n',
      hash: 'h2',
      bytes: 12,
      summary: 'created; edited',
      updatedAt: AT,
    });
    store.sealRevision('rev-01');
    const rev = store.revision('rev-01');
    expect(rev?.sealed).toBe(true);
    expect(rev?.body).toBe('# Auth\nmore\n');
    expect(store.maxN('doc-01')).toBe(1);
    expect(store.revisionByN('doc-01', 1)?.id).toBe('rev-01');
    store.insertRevision(revRow({ id: 'rev-02', n: 2, parents: ['rev-01'] }));
    expect(
      store.revisionMetas('doc-01', { limit: 10 }).map((r) => r.n)
    ).toEqual([2, 1]);
    expect(
      store.revisionMetas('doc-01', { before: 2, limit: 10 }).map((r) => r.n)
    ).toEqual([1]);
  });

  it('keeps proposal revisions (n null) out of history', () => {
    store.transaction(() => {
      store.putDoc(docRow());
      store.insertRevision(revRow());
      store.insertRevision(
        revRow({ id: 'rev-p', n: null, cause: 'proposal', parents: ['rev-01'] })
      );
    });
    expect(
      store.revisionMetas('doc-01', { limit: 10 }).map((r) => r.id)
    ).toEqual(['rev-01']);
  });

  it('finds docs by handle, retired slug and origin, per namespace', () => {
    store.putDoc(docRow({ origin: 'import:auth' }));
    store.addAlias('team', 'old-auth', 'doc-01', AT);
    expect(store.docByHandle('team', 'auth')?.id).toBe('doc-01');
    expect(store.docByHandle('p:alice', 'auth')).toBeNull();
    expect(store.docByAlias('team', 'old-auth')?.id).toBe('doc-01');
    expect(store.docByOrigin('import:auth')?.id).toBe('doc-01');
    expect(store.slugTaken('team', 'old-auth')).toBe(true);
    expect(store.slugTaken('p:alice', 'auth')).toBe(false);
    // A doc's own handle and retired slugs are not taken from itself.
    expect(store.slugTaken('team', 'old-auth', 'doc-01')).toBe(false);
    expect(store.slugTaken('team', 'auth', 'doc-01')).toBe(false);
    expect(store.slugTaken('team', 'old-auth', 'doc-02')).toBe(true);
  });

  it('allows one team spec and one personal spec per task and namespace', () => {
    store.putDoc(docRow());
    store.putDoc(
      docRow({ id: 'doc-02', handle: 'b', slug: 'b', headId: 'rev-02' })
    );
    store.putDoc(
      docRow({
        id: 'doc-03',
        ns: 'p:alice',
        handle: 'c',
        slug: 'c',
        scope: 'personal',
        headId: 'rev-03',
      })
    );
    const link = {
      targetType: 'task' as const,
      targetId: 't-4a8cce',
      rel: 'spec' as const,
      source: 'manual' as const,
      createdBy: 'human:wyat',
      createdAt: AT,
    };
    store.addLink({ ...link, docId: 'doc-01', docNs: 'team' });
    expect(() =>
      store.addLink({ ...link, docId: 'doc-02', docNs: 'team' })
    ).toThrow();
    store.addLink({ ...link, docId: 'doc-03', docNs: 'p:alice' });
    expect(store.specFor('task', 't-4a8cce', 'team')?.docId).toBe('doc-01');
    expect(store.specFor('task', 't-4a8cce', 'p:alice')?.docId).toBe('doc-03');
  });

  it('replaces only mention links and never overrides a manual link', () => {
    store.putDoc(docRow());
    const base = {
      docId: 'doc-01',
      docNs: 'team',
      targetType: 'doc' as const,
      createdBy: 'human:wyat',
      createdAt: AT,
    };
    store.addLink({
      ...base,
      targetId: 'doc-02',
      rel: 'plan',
      source: 'manual',
    });
    store.replaceMentions('doc-01', 'team', [
      { ...base, targetId: 'doc-02', rel: 'context', source: 'mention' },
      { ...base, targetId: 'doc-03', rel: 'context', source: 'mention' },
    ]);
    store.replaceMentions('doc-01', 'team', [
      { ...base, targetId: 'doc-04', rel: 'context', source: 'mention' },
    ]);
    expect(
      store.links({ docId: 'doc-01' }).map((l) => [l.targetId, l.rel, l.source])
    ).toEqual([
      ['doc-02', 'plan', 'manual'],
      ['doc-04', 'context', 'mention'],
    ]);
  });

  it('searches heads with bm25, title weighted, per namespace and without archived docs', () => {
    store.putDoc(docRow({ title: 'Tokens' }));
    store.replaceSections(
      'doc-01',
      'Tokens',
      [section(0, '', 'intro'), section(1, 'API', 'signed cookies')],
      'h1'
    );
    store.putDoc(
      docRow({
        id: 'doc-02',
        handle: 'tokens',
        slug: 'tokens',
        title: 'Other',
        headId: 'rev-02',
      })
    );
    store.replaceSections(
      'doc-02',
      'Other',
      [section(1, 'Notes', 'we mint tokens here')],
      'h2'
    );
    store.putDoc(
      docRow({
        id: 'doc-03',
        ns: 'p:alice',
        handle: 'x',
        slug: 'x',
        title: 'Tokens mine',
        headId: 'rev-03',
      })
    );
    store.replaceSections(
      'doc-03',
      'Tokens mine',
      [section(1, 'Me', 'tokens')],
      'h3'
    );
    const hits = store.search('tokens', ['team'], {
      includeArchived: false,
      limit: 10,
    });
    expect(hits.map((h) => h.docId)).toEqual(['doc-01', 'doc-01', 'doc-02']);
    expect(hits[2].snippet).toContain('[tokens]');
    store.putDoc({
      ...docRow({
        id: 'doc-02',
        handle: 'tokens',
        slug: 'tokens',
        title: 'Other',
        headId: 'rev-02',
      }),
      status: 'archived',
    });
    expect(
      store
        .search('tokens', ['team'], { includeArchived: false, limit: 10 })
        .map((h) => h.docId)
    ).toEqual(['doc-01', 'doc-01']);
    expect(
      store
        .search('tokens', ['team', 'p:alice'], {
          includeArchived: true,
          limit: 10,
        })
        .map((h) => h.docId)
    ).toContain('doc-03');
  });

  it('quotes FTS syntax so a query cannot change its meaning', () => {
    store.putDoc(docRow());
    store.replaceSections(
      'doc-01',
      'Auth',
      [section(1, 'API', 'NEAR( "quoted" -minus *star')],
      'h1'
    );
    expect(() =>
      store.search('NEAR( "quoted" -minus *star AND :', ['team'], {
        includeArchived: false,
        limit: 5,
      })
    ).not.toThrow();
  });

  it('removes every row of a deleted doc, including links that point at it', () => {
    store.transaction(() => {
      store.putDoc(docRow());
      store.insertRevision(revRow());
      store.addReview('doc-01', 'rev-01', 'human:wyat', AT);
      store.replaceSections('doc-01', 'Auth', [section(0, '', 'x')], 'h1');
      store.addAlias('team', 'old', 'doc-01', AT);
      store.putDoc(
        docRow({ id: 'doc-02', handle: 'b', slug: 'b', headId: 'rev-02' })
      );
      store.addLink({
        docId: 'doc-02',
        docNs: 'team',
        targetType: 'doc',
        targetId: 'doc-01',
        rel: 'context',
        source: 'manual',
        createdBy: 'human:wyat',
        createdAt: AT,
      });
    });
    store.deleteDoc('doc-01');
    expect(store.doc('doc-01')).toBeNull();
    expect(store.revision('rev-01')).toBeNull();
    expect(store.hasReview('rev-01')).toBe(false);
    expect(store.sectionRows('doc-01')).toEqual([]);
    expect(store.docByAlias('team', 'old')).toBeNull();
    expect(store.links({ target: { type: 'doc', id: 'doc-01' } })).toEqual([]);
  });

  it('lists open heads and heads whose index is stale', () => {
    store.transaction(() => {
      store.putDoc(docRow({ indexedHash: 'old' }));
      store.insertRevision(revRow());
    });
    expect(store.openHeads().map((r) => r.id)).toEqual(['rev-01']);
    expect(store.staleIndexes()).toEqual([
      { docId: 'doc-01', headId: 'rev-01' },
    ]);
    store.sealRevision('rev-01');
    store.replaceSections('doc-01', 'Auth', [], 'h1');
    expect(store.openHeads()).toEqual([]);
    expect(store.staleIndexes()).toEqual([]);
  });

  it('filters the list by a title substring, escaping LIKE wildcards', () => {
    store.putDoc(docRow({ title: 'Auth 100% plan' }));
    store.putDoc(
      docRow({
        id: 'doc-02',
        handle: 'b',
        slug: 'b',
        headId: 'rev-02',
        title: 'Billing',
      })
    );
    const list = (query: string) =>
      store
        .listDocs({
          ns: ['team'],
          statuses: ['draft'],
          query,
          limit: 10,
          offset: 0,
        })
        .rows.map((r) => r.id);
    expect(list('auth')).toEqual(['doc-01']);
    expect(list('100%')).toEqual(['doc-01']);
    expect(list('_')).toEqual([]);
  });

  it("counts a principal's creates since a time", () => {
    store.putDoc(
      docRow({ createdBy: 'run:r-1', createdAt: '2026-09-26T09:30:00.000Z' })
    );
    store.putDoc(
      docRow({
        id: 'doc-02',
        handle: 'b',
        slug: 'b',
        headId: 'rev-02',
        createdBy: 'run:r-1',
        createdAt: '2026-09-26T08:00:00.000Z',
      })
    );
    expect(store.countCreatedSince('run:r-1', '2026-09-26T09:00:00.000Z')).toBe(
      1
    );
  });
});

describe('SqliteDocStore without FTS5', () => {
  it('serves head bodies for the LIKE fallback and skips the FTS table', () => {
    const { db, fts } = openDocsDb(':memory:', { fts: false });
    const plain = new SqliteDocStore(db, fts);
    plain.transaction(() => {
      plain.putDoc(docRow());
      plain.insertRevision(revRow({ body: '# Auth\ntokens\n' }));
      plain.replaceSections(
        'doc-01',
        'Auth',
        [section(1, 'Auth', 'tokens')],
        'h1'
      );
    });
    expect(plain.headBodies(['team'], false).map((h) => h.body)).toEqual([
      '# Auth\ntokens\n',
    ]);
    expect(() =>
      plain.search('tokens', ['team'], { includeArchived: false, limit: 5 })
    ).toThrow('FTS5 is not available');
    plain.close();
  });
});

describe('later columns', () => {
  it('adds publishes.reason to a docs.db made before it existed', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'docs-cols-')));
    try {
      const path = join(base, 'docs.db');
      const old = openSqliteDb(path);
      old.exec(
        'CREATE TABLE publishes (task_id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, rev_id TEXT NOT NULL, path TEXT NOT NULL, state TEXT NOT NULL, "commit" TEXT, created_at TEXT NOT NULL)'
      );
      old.close();
      const { db, fts } = openDocsDb(path);
      const store = new SqliteDocStore(db, fts);
      store.putPublish({
        task: 't-1',
        doc: 'doc-1',
        rev: 'rev-1',
        path: 'docs/a.md',
        state: 'failed',
        commit: null,
        createdAt: AT,
        reason: 'why',
        baseCommit: null,
      });
      expect(store.publishRows({ task: 't-1' })[0].reason).toBe('why');
      store.close();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
