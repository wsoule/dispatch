import type {
  DocConflict,
  DocOp,
  DocProposal,
  DocRead,
  DocRecord,
  DocRevisionInfo,
  DocSaveResult,
  DocScope,
  DocStatus,
  DocSummary,
  LinkRel,
  ProposalState,
} from '@dispatch/core';

import { CliError } from './context.js';

// The docs routes `dispatch docs` calls, on a human's token. The CLI never
// reads a token an agent could reach, so agents use the MCP tools instead.

type DocSaveOutcome =
  | { ok: true; result: DocSaveResult }
  | { ok: false; conflict: DocConflict };

// One file of an import manifest, as the daemon's import takes it.
interface ImportFileInfo {
  path: string;
  name: string;
  mtime: string;
  bytes: number;
  hash: string;
}

// The import's count-parity report, mirrored from the daemon's (the CLI cannot import the server).
export interface ImportReportInfo {
  dryRun: boolean;
  files: number;
  names: number;
  distinctContents: number;
  docsCreated: number;
  docsExisting: number;
  partDocsCreated: number;
  contentsImported: number;
  splitContents: number;
  revisionsCreated: number;
  duplicates: number;
  alreadyPresent: number;
  tombstoned: number;
  tombstonedNames: number;
  failedNames: number;
  errors: {
    path: string;
    reason: 'invalid' | 'too-large' | 'not UTF-8' | 'missing' | 'archived';
    detail: string;
  }[];
  parity: { files: boolean; names: boolean; images?: boolean };
  // Each imported name's docs, after a commit; the CLI uploads their images to them.
  docs?: { name: string; docs: string[] }[];
  // Images an exported doc referenced: uploaded, and those whose bytes were not found.
  images?: { referenced: number; uploaded: number; missing: number };
}

/** What POST /api/docs/:ref/publish answers: the task, and its run unless not dispatched. */
interface DocPublishResult {
  task: string;
  doc: DocRecord;
  run: string | null;
  dispatchError: string | null;
}

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
  // Numbered revisions newest first; `before` pages to those below that number.
  history(
    ref: string,
    limit?: number,
    before?: number
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
  // A personal doc's head as a new team draft; its owner only.
  promote(ref: string): Promise<DocSaveResult>;
  setStatus(ref: string, status: DocStatus): Promise<DocRecord>;
  // An elevated task that writes the doc's head to `path` in the repo (humans only).
  publish(
    ref: string,
    input: { path: string; dispatch?: boolean }
  ): Promise<DocPublishResult>;
  reviewed(ref: string): Promise<DocRecord>;
  remove(ref: string): Promise<void>;
  // A doc's stored image as bytes; null when the daemon has none of that name.
  asset(ref: string, name: string): Promise<Uint8Array | null>;
  // Stores an image for a doc; the daemon names it by its bytes' hash.
  putAsset(
    ref: string,
    bytes: Uint8Array
  ): Promise<{ name: string; markdown: string }>;
  // Proposals to accepted docs the caller may see.
  proposals(params?: {
    doc?: string;
    state?: ProposalState[];
  }): Promise<{ proposals: DocProposal[] }>;
  openImport(
    files: ImportFileInfo[],
    link?: string
  ): Promise<{ id: string; need: string[] }>;
  putImportContent(id: string, hash: string, bytes: Uint8Array): Promise<void>;
  commitImport(id: string, dryRun: boolean): Promise<ImportReportInfo>;
  deleteImport(id: string): Promise<void>;
}

const docPath = (ref: string): string => `/api/docs/${encodeURIComponent(ref)}`;

// `path` with `?query` appended, or bare when the query is empty.
const withQuery = (path: string, q: URLSearchParams): string => {
  const qs = q.toString();
  return qs === '' ? path : `${path}?${qs}`;
};

// The server's message for a failed response, with the field it names.
function cliError(status: number, body: unknown): CliError {
  const err = body as { error?: string; field?: string } | null;
  const message = err?.error ?? `HTTP ${status}`;
  return new CliError(
    err?.field === undefined ? message : `${message} (field: ${err.field})`
  );
}

// Only a whole-body save's merge conflict carries these reasons; other 409s,
// such as an archived doc's, are a plain error body.
function isDocConflict(body: unknown): body is DocConflict {
  const reason = (body as { reason?: unknown } | null)?.reason;
  return reason === 'merge-conflict' || reason === 'base-changed';
}

export function createDocsApi(baseUrl: string, token: string): DocsApi {
  // One request; a status in `allowed` returns instead of throwing, and any
  // other failure throws a cliError.
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
    throw cliError(res.status, await res.json().catch(() => null));
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
      if (res.status !== 409) {
        return { ok: true, result: (await res.json()) as DocSaveResult };
      }
      const body: unknown = await res.json().catch(() => null);
      if (isDocConflict(body)) return { ok: false, conflict: body };
      throw cliError(409, body);
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
    history: (ref, limit = 50, before) => {
      const q = new URLSearchParams({ limit: String(limit) });
      if (before !== undefined) q.set('before', String(before));
      return json('GET', withQuery(`${docPath(ref)}/revisions`, q));
    },
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
    promote: (ref) => json('POST', `${docPath(ref)}/promote`, {}),
    setStatus: (ref, status) =>
      json('POST', `${docPath(ref)}/status`, { status }),
    publish: (ref, input) => json('POST', `${docPath(ref)}/publish`, input),
    reviewed: (ref) => json('POST', `${docPath(ref)}/reviewed`, {}),
    remove: async (ref) => {
      await call('DELETE', docPath(ref));
    },
    asset: async (ref, name) => {
      const res = await call(
        'GET',
        `${docPath(ref)}/assets/${encodeURIComponent(name)}`,
        undefined,
        [404]
      );
      return res.status === 404
        ? null
        : new Uint8Array(await res.arrayBuffer());
    },
    putAsset: async (ref, bytes) => {
      const res = await fetch(`${baseUrl}${docPath(ref)}/assets`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          authorization: `Bearer ${token}`,
        },
        body: bytes,
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) throw cliError(res.status, body);
      return body as { name: string; markdown: string };
    },
    proposals: (p = {}) => {
      const q = new URLSearchParams();
      if (p.doc !== undefined) q.set('doc', p.doc);
      if (p.state !== undefined) q.set('state', p.state.join(','));
      return json('GET', withQuery('/api/docs/proposals', q));
    },
    openImport: (files, link) =>
      json(
        'POST',
        '/api/docs/imports',
        link === undefined ? { files } : { files, link }
      ),
    // Raw bytes, not JSON: the daemon takes contents only as octet-stream.
    putImportContent: async (id, hash, bytes) => {
      const res = await fetch(
        `${baseUrl}/api/docs/imports/${encodeURIComponent(id)}/contents/${encodeURIComponent(hash)}`,
        {
          method: 'PUT',
          headers: {
            'content-type': 'application/octet-stream',
            authorization: `Bearer ${token}`,
          },
          body: bytes,
        }
      );
      if (!res.ok)
        throw cliError(res.status, await res.json().catch(() => null));
    },
    commitImport: (id, dryRun) =>
      json(
        'POST',
        `/api/docs/imports/${encodeURIComponent(id)}/commit${dryRun ? '?dryRun=1' : ''}`,
        {}
      ),
    deleteImport: async (id) => {
      await call('DELETE', `/api/docs/imports/${encodeURIComponent(id)}`);
    },
  };
}
