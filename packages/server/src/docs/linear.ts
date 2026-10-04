import { DocsError } from './errors.js';
import type { DocsActor, DocsService } from './service.js';

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
    const { state, head, baseBody } = ready;
    const before = await port.document(state.documentId);
    if (
      before.updatedAt !== state.remoteUpdatedAt ||
      before.content !== baseBody
    ) {
      this.fold(before);
      return 'pulled-first';
    }
    if (head.id === state.baseRev) return 'pushed';
    await port.documentUpdate(state.documentId, head.body);
    const after = await port.document(state.documentId);
    const history = await port.contentHistory(state.documentId);
    // Linear now holds the pushed revision; anything else in `after` is an
    // edit made after the write, merged in against it.
    service.linearPushed(docId, head.id, before.updatedAt);
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
    const container = source.taskIds
      .map((t) => this.deps.containerFor(t))
      .find((c) => c !== null);
    if (container === undefined)
      throw new DocsError(
        'invalid',
        'link the doc to a task synced with a Linear project or issue first',
        'links'
      );
    const created = await port.documentCreate({
      title: source.title,
      content: source.body,
      ...container,
    });
    service.linearShared(source.docId, created.id, created.updatedAt);
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
