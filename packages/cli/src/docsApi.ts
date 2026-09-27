import type {
  DocConflict,
  DocOp,
  DocRead,
  DocRecord,
  DocRevisionInfo,
  DocSaveResult,
  DocScope,
  DocStatus,
  DocSummary,
  LinkRel,
} from '@dispatch/core';

import { CliError } from './context.js';

// The docs routes `dispatch docs` calls, on a human's token. The CLI never
// reads a token an agent could reach, so agents use the MCP tools instead.

type DocSaveOutcome =
  | { ok: true; result: DocSaveResult }
  | { ok: false; conflict: DocConflict };

export interface DocsApi {
  list(params?: {
    taskId?: string;
    scope?: DocScope;
    status?: DocStatus;
    includeArchived?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{ docs: DocSummary[]; total: number }>;
  get(
    ref: string,
    opts?: { rev?: string | number; section?: string }
  ): Promise<DocRead>;
  create(input: {
    title: string;
    body: string;
    slug?: string;
    scope?: DocScope;
    links?: { target: string; rel: LinkRel }[];
  }): Promise<DocSaveResult>;
  saveBody(
    ref: string,
    input: {
      baseRev: string | number;
      baseHash?: string;
      body: string;
      title?: string;
    }
  ): Promise<DocSaveOutcome>;
  edit(
    ref: string,
    input: { ops: DocOp[]; baseRev?: string | number }
  ): Promise<DocSaveResult>;
  seal(ref: string): Promise<DocRecord>;
  link(
    ref: string,
    input: { target: string; rel: LinkRel; replace?: boolean }
  ): Promise<unknown>;
  unlink(ref: string, target: string): Promise<unknown>;
  history(
    ref: string,
    limit?: number
  ): Promise<{ revisions: DocRevisionInfo[] }>;
  revision(
    ref: string,
    rev: string | number
  ): Promise<DocRevisionInfo & { body: string }>;
  diff(
    ref: string,
    from: string | number,
    to: string | number
  ): Promise<{ chunks: { equal: boolean; a: string[]; b: string[] }[] }>;
  revert(ref: string, rev: string | number): Promise<DocSaveResult>;
  setStatus(ref: string, status: DocStatus): Promise<DocRecord>;
  reviewed(ref: string): Promise<DocRecord>;
  remove(ref: string): Promise<void>;
}

const docPath = (ref: string): string => `/api/docs/${encodeURIComponent(ref)}`;

// `path` with `?query` appended, or bare when the query is empty.
const withQuery = (path: string, q: URLSearchParams): string => {
  const qs = q.toString();
  return qs === '' ? path : `${path}?${qs}`;
};

export function createDocsApi(baseUrl: string, token: string): DocsApi {
  // One request; a status in `allowed` returns instead of throwing, and any
  // other failure throws the server's message with the field it names.
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    allowed: readonly number[] = []
  ): Promise<Response> => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok || allowed.includes(res.status)) return res;
    const err = (await res.json().catch(() => ({}))) as {
      error?: string;
      field?: string;
    };
    const message = err.error ?? `HTTP ${res.status}`;
    throw new CliError(
      err.field === undefined ? message : `${message} (field: ${err.field})`
    );
  };
  const json = async <T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> => (await call(method, path, body)).json() as Promise<T>;
  return {
    list: (p = {}) => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(p)) {
        if (v === undefined || v === false) continue;
        q.set(k, v === true ? '1' : String(v));
      }
      return json('GET', withQuery('/api/docs', q));
    },
    get: (ref, opts = {}) => {
      const q = new URLSearchParams();
      if (opts.rev !== undefined) q.set('rev', String(opts.rev));
      if (opts.section !== undefined) q.set('section', opts.section);
      return json('GET', withQuery(docPath(ref), q));
    },
    create: (input) => json('POST', '/api/docs', input),
    saveBody: async (ref, input) => {
      const res = await call('PUT', `${docPath(ref)}/body`, input, [409]);
      const body = await res.json();
      return res.status === 409
        ? { ok: false, conflict: body as DocConflict }
        : { ok: true, result: body as DocSaveResult };
    },
    edit: (ref, input) => json('POST', `${docPath(ref)}/edit`, input),
    seal: (ref) => json('POST', `${docPath(ref)}/seal`, {}),
    link: (ref, input) => json('POST', `${docPath(ref)}/links`, input),
    // The route takes the target's type and id as two path segments.
    unlink: (ref, target) => {
      const colon = target.indexOf(':');
      return json(
        'DELETE',
        `${docPath(ref)}/links/${encodeURIComponent(target.slice(0, colon))}/${encodeURIComponent(target.slice(colon + 1))}`
      );
    },
    history: (ref, limit = 50) =>
      json('GET', `${docPath(ref)}/revisions?limit=${limit}`),
    revision: (ref, rev) =>
      json(
        'GET',
        `${docPath(ref)}/revisions/${encodeURIComponent(String(rev))}`
      ),
    diff: (ref, from, to) =>
      json(
        'GET',
        `${docPath(ref)}/diff?from=${encodeURIComponent(String(from))}&to=${encodeURIComponent(String(to))}`
      ),
    revert: (ref, rev) => json('POST', `${docPath(ref)}/revert`, { rev }),
    setStatus: (ref, status) =>
      json('POST', `${docPath(ref)}/status`, { status }),
    reviewed: (ref) => json('POST', `${docPath(ref)}/reviewed`, {}),
    remove: async (ref) => {
      await call('DELETE', docPath(ref));
    },
  };
}
