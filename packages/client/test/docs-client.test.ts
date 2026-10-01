import { describe, expect, it } from 'bun:test';

import { ApiError, createApiClient } from '../src/api';

const BASE = 'http://example.test';

// Answers every fetch with one status and JSON body, recording each call.
function stub(
  status: number,
  body: unknown
): { calls: { url: string; init?: RequestInit }[]; restore(): void } {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    );
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

// Each binding must hit the route the server's docs/routes.ts registers, with
// the query parameters it parses.
describe('docs bindings', () => {
  it('encodes a personal handle and passes read options', async () => {
    const s = stub(200, {});
    try {
      await createApiClient(BASE, 't').getDoc('~notes', {
        section: 'API',
        page: true,
      });
      expect(s.calls[0].url).toBe(`${BASE}/api/docs/~notes?section=API&page=1`);
    } finally {
      s.restore();
    }
  });

  it('returns a 409 conflict as a value instead of throwing', async () => {
    const conflict = {
      error: 'x',
      code: 'conflict',
      reason: 'merge-conflict',
      head: { id: 'rev-1', n: 2, hash: 'h', body: 'b', author: 'run:r-1' },
      base: { id: 'rev-0', n: 1 },
      hunks: [],
      marked: 'm',
    };
    const s = stub(409, conflict);
    try {
      const out = await createApiClient(BASE, 't').saveDocBody('spec', {
        baseRev: 1,
        body: 'x',
      });
      expect(out).toEqual({ ok: false, conflict: conflict as never });
      expect(s.calls[0].init?.method).toBe('PUT');
    } finally {
      s.restore();
    }
  });

  it('still throws other failures', async () => {
    const s = stub(403, { error: 'no', code: 'forbidden' });
    try {
      const err: unknown = await createApiClient(BASE, 't')
        .saveDocBody('spec', { baseRev: 1, body: 'x' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 403, code: 'forbidden' });
    } finally {
      s.restore();
    }
  });

  it('throws a 409 that carries no merge conflict, such as an archived doc', async () => {
    const s = stub(409, {
      error: 'archived; restore it first',
      code: 'conflict',
      field: 'doc',
    });
    try {
      const err: unknown = await createApiClient(BASE, 't')
        .saveDocBody('spec', { baseRev: 1, body: 'x' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({
        message: 'archived; restore it first',
        status: 409,
        code: 'conflict',
        field: 'doc',
      });
    } finally {
      s.restore();
    }
  });

  it('builds list, search, links and unlink paths', async () => {
    const s = stub(200, { docs: [], total: 0, hits: [], links: [] });
    try {
      const c = createApiClient(BASE, 't');
      await c.listDocs({ taskId: 't-1', includeArchived: true, limit: 5 });
      await c.searchDocs('two words', { limit: 3 });
      await c.docsLinking('task:t-1');
      await c.unlinkDoc('spec', 'task:t-1');
      expect(s.calls.map((c2) => c2.url)).toEqual([
        `${BASE}/api/docs?taskId=t-1&includeArchived=1&limit=5`,
        `${BASE}/api/docs/search?q=two+words&limit=3`,
        `${BASE}/api/docs/links?target=task%3At-1`,
        `${BASE}/api/docs/spec/links/task/t-1`,
      ]);
    } finally {
      s.restore();
    }
  });

  it('builds the proposal list and view paths', async () => {
    const s = stub(200, { proposals: [] });
    try {
      const c = createApiClient(BASE, 't');
      await c.listDocProposals();
      await c.listDocProposals({ doc: 'spec', state: ['open', 'failed'] });
      await c.getDocProposal('rev-01K');
      expect(s.calls.map((c2) => decodeURIComponent(c2.url))).toEqual([
        `${BASE}/api/docs/proposals`,
        `${BASE}/api/docs/proposals?doc=spec&state=open,failed`,
        `${BASE}/api/docs/proposals/rev-01K`,
      ]);
    } finally {
      s.restore();
    }
  });

  it('sends seal, reviewed, rename, revision and diff calls', async () => {
    const s = stub(200, {});
    try {
      const c = createApiClient(BASE, 't');
      await c.sealDoc('spec');
      await c.markDocReviewed('spec');
      await c.renameDoc('spec', 'new-spec');
      await c.getDocRevision('spec', 'rev-2');
      await c.diffDoc('spec', 1, 'rev-3');
      expect(
        s.calls.map((call) => ({
          url: call.url,
          method: call.init?.method ?? 'GET',
          body: call.init?.body,
        }))
      ).toEqual([
        { url: `${BASE}/api/docs/spec/seal`, method: 'POST', body: undefined },
        {
          url: `${BASE}/api/docs/spec/reviewed`,
          method: 'POST',
          body: undefined,
        },
        {
          url: `${BASE}/api/docs/spec`,
          method: 'PATCH',
          body: '{"slug":"new-spec"}',
        },
        {
          url: `${BASE}/api/docs/spec/revisions/rev-2`,
          method: 'GET',
          body: undefined,
        },
        {
          url: `${BASE}/api/docs/spec/diff?from=1&to=rev-3`,
          method: 'GET',
          body: undefined,
        },
      ]);
      // A body-less POST still declares JSON, so the server's content-type gate passes it.
      expect(new Headers(s.calls[0].init?.headers).get('content-type')).toBe(
        'application/json'
      );
    } finally {
      s.restore();
    }
  });

  it('promotes a personal doc through a body-less POST', async () => {
    const s = stub(201, { handle: 'notes' });
    try {
      expect(await createApiClient(BASE, 't').promoteDoc('~notes')).toEqual({
        handle: 'notes',
      } as never);
      expect(s.calls[0].url).toBe(`${BASE}/api/docs/~notes/promote`);
      expect(s.calls[0].init?.method).toBe('POST');
    } finally {
      s.restore();
    }
  });

  it('publishes a doc with its path and dispatch choice', async () => {
    const s = stub(201, { task: 't-pub-1' });
    try {
      await createApiClient(BASE, 't').publishDoc('spec', {
        path: 'docs/spec.md',
        dispatch: false,
      });
      expect(s.calls[0].url).toBe(`${BASE}/api/docs/spec/publish`);
      expect(s.calls[0].init?.method).toBe('POST');
      expect(s.calls[0].init?.body).toBe(
        '{"path":"docs/spec.md","dispatch":false}'
      );
    } finally {
      s.restore();
    }
  });

  it('deletes through a 204 that has no body', async () => {
    const s = stub(204, null);
    try {
      expect(
        await createApiClient(BASE, 't').deleteDoc('~notes')
      ).toBeUndefined();
      expect(s.calls[0].url).toBe(`${BASE}/api/docs/~notes`);
      expect(s.calls[0].init?.method).toBe('DELETE');
    } finally {
      s.restore();
    }
  });
});
