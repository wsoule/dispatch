import { docBodyProblem, normalizeDocText } from '@dispatch/core';
import { createHash } from 'node:crypto';

import { DocsError } from './errors.js';
import type { DocsActor, DocsService } from './service.js';
import { splitForCap } from './transfer.js';

const OVERSIZE_NOTE =
  "[Linear's version of this doc is over the size limit; the rest is only in Linear]\n";

/** Linear's markdown as docs compare and hold it. */
export interface LinearText {
  /** Normalized and cut to the body cap: the merge base Linear holds. */
  cut: string;
  /** What a doc made from it holds: `cut`, plus a note when cut. */
  body: string;
  /** sha256 of the whole normalized text, so both sides compare alike. */
  hash: string;
  over: boolean;
}

// Normalizes Linear's markdown (BOM, CRLF) and cuts it to the body cap the
// way an import does; a cut copy carries a note and is never pushed back.
export function linearText(content: string): LinearText {
  const normal = normalizeDocText(content);
  const hash = createHash('sha256').update(normal).digest('hex');
  if (docBodyProblem(normal) === null)
    return { cut: normal, body: normal, hash, over: false };
  let cut = splitForCap(normal)[0] ?? '';
  if (cut !== '' && !cut.endsWith('\n')) cut += '\n';
  // Room for the note: drop trailing lines until the noted body fits.
  while (cut !== '' && docBodyProblem(cut + OVERSIZE_NOTE) !== null) {
    const lines = cut.split('\n');
    cut = `${lines.slice(0, -2).join('\n')}\n`;
    if (cut === '\n') cut = '';
  }
  return { cut, body: cut + OVERSIZE_NOTE, hash, over: true };
}

// One Linear document as the adapter sees it; `content` is Linear's markdown,
// untrusted text that only ever reaches a prompt fenced as a doc body.
export interface LinearDocument {
  id: string;
  title: string;
  content: string;
  updatedAt: string;
  updatedBy: string | null;
  parent: {
    kind: 'project' | 'issue' | 'initiative' | 'cycle' | 'team' | 'release';
    id: string;
  } | null;
}

// The slice of Linear's API the adapter needs; the sync engine wraps its client
// as this, and tests use an in-memory fake.
export interface LinearDocsPort {
  documentsUpdatedSince(cursor: string | null): Promise<LinearDocument[]>;
  document(id: string): Promise<LinearDocument>;
  documentUpdate(id: string, content: string): Promise<void>;
  documentCreate(input: {
    title: string;
    content: string;
    projectId?: string;
    issueId?: string;
  }): Promise<LinearDocument>;
  contentHistory(
    id: string
  ): Promise<{ contentDataSnapshotAt: string; actorIds: string[] }[]>;
  integrationUserId(): string;
}

export interface LinearDocsDeps {
  service: DocsService;
  port: LinearDocsPort;
  // The Dispatch task a Linear parent maps to (containers are tasks), or null.
  taskFor(parent: LinearDocument['parent']): string | null;
  // The Linear project or issue a Dispatch task maps to, for "Share to Linear".
  containerFor(
    taskId: string
  ): { projectId: string } | { issueId: string } | null;
  // The Dispatch person a Linear user maps to, or null.
  personFor(linearUserId: string | null): string | null;
  problem(docId: string, detail: string): void;
}

export type LinearPushResult =
  | 'pushed'
  | 'held'
  | 'pulled-first'
  | 'merged-back'
  | 'overwritten'
  | 'not-linear';

// Who an unmapped Linear edit is written as.
const UNMAPPED_AUTHOR = 'agent:dispatch';

// Syncs Linear documents with docs: pull folds Linear edits in, push sends a
// Linear-origin doc's sealed head back, and share makes a team doc Linear-origin.
// Personal docs never take part.
export class LinearDocsAdapter {
  constructor(private readonly deps: LinearDocsDeps) {}

  async pull(cursor: string | null): Promise<{
    created: number;
    merged: number;
    conflicted: number;
    proposed: number;
    cursor: string | null;
  }> {
    const out = { created: 0, merged: 0, conflicted: 0, proposed: 0, cursor };
    for (const doc of await this.deps.port.documentsUpdatedSince(cursor)) {
      try {
        const result = this.fold(doc);
        if (result !== 'unchanged') out[result] += 1;
      } catch (err) {
        console.error(`docs: Linear document ${doc.id} was not synced`, err);
      }
      if (out.cursor === null || later(doc.updatedAt, out.cursor))
        out.cursor = doc.updatedAt;
    }
    return out;
  }

  // Folds the named documents, read one by one: what a webhook delivered.
  async pullIds(ids: readonly string[]): Promise<number> {
    let changed = 0;
    for (const id of ids) {
      const doc = await this.deps.port.document(id);
      try {
        if (this.fold(doc) !== 'unchanged') changed += 1;
      } catch (err) {
        console.error(`docs: Linear document ${id} was not synced`, err);
      }
    }
    return changed;
  }

  // Push narrows the window a non-conditional documentUpdate leaves, then
  // detects what it could not prevent (spec "Linear documents", Push).
  async push(docId: string): Promise<LinearPushResult> {
    const { service, port } = this.deps;
    const ready = service.linearPushSource(docId);
    if (ready === null) return 'not-linear';
    const { state, head, held } = ready;
    const before = await port.document(state.documentId);
    // Linear's text is compared as docs hold it, against Linear's own last text.
    if (
      before.updatedAt !== state.remoteUpdatedAt ||
      linearText(before.content).hash !== state.remoteHash
    ) {
      this.fold(before);
      return 'pulled-first';
    }
    if (held) return 'held';
    if (linearText(head.body).hash === state.remoteHash) return 'pushed';
    await port.documentUpdate(state.documentId, head.body);
    const after = await port.document(state.documentId);
    const history = await port.contentHistory(state.documentId);
    // Linear now holds the pushed revision; anything else in `after` is an
    // edit made after the write, merged in against it.
    service.linearPushed(docId, head.id, head.body, before.updatedAt);
    const mergedBack = this.fold(after) !== 'unchanged';
    const integration = port.integrationUserId();
    const overwritten = history.find(
      (h) =>
        later(h.contentDataSnapshotAt, before.updatedAt) &&
        h.actorIds.some((a) => a !== integration)
    );
    if (overwritten !== undefined) {
      const who = overwritten.actorIds.filter((a) => a !== integration);
      const detail = `a Linear edit by ${who.join(', ')} at ${overwritten.contentDataSnapshotAt} was overwritten; see Linear's version history`;
      service.recordProblem(docId, detail);
      this.deps.problem(docId, detail);
      return 'overwritten';
    }
    return mergedBack ? 'merged-back' : 'pushed';
  }

  // "Share to Linear": a decide-tier human's team doc, linked to a task mapped
  // to a Linear project or issue, becomes a Linear document. Every refusal
  // happens before any Linear call.
  async share(actor: DocsActor, ref: string): Promise<string> {
    const { service, port } = this.deps;
    const source = service.linearShareSource(actor, ref);
    // The claim linearShareSource took is released on any refusal or failure.
    let created: LinearDocument;
    try {
      const container = source.taskIds
        .map((t) => this.deps.containerFor(t))
        .find((c) => c !== null);
      if (container === undefined)
        throw new DocsError(
          'invalid',
          'link the doc to a task synced with a Linear project or issue first',
          'links'
        );
      created = await port.documentCreate({
        title: source.title,
        content: source.body,
        ...container,
      });
    } catch (err) {
      service.linearShareFailed(source.docId);
      throw err;
    }
    service.linearShared(
      source.docId,
      created.id,
      created.updatedAt,
      source.body
    );
    return created.id;
  }

  private fold(doc: LinearDocument) {
    return this.deps.service.linearUpsert(
      doc,
      this.deps.taskFor(doc.parent),
      this.deps.personFor(doc.updatedBy) ?? UNMAPPED_AUTHOR
    );
  }
}

// Whether ISO time `a` is after `b`; an unparseable one is never later.
function later(a: string, b: string): boolean {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) && x > y;
}
