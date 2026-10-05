import type { JsonValue } from '@dispatch/protocol';
import type { DocBody } from '@dispatch/protocol/federation';

import type { DocsPort } from '../../../../src/team/federation/ops.js';

// A DocsPort that records what federation hands it and answers as told
// (docs plan XD1): each body's meta.title names it in the assertions.
export class RecordingDocsPort implements DocsPort {
  seen: {
    title: string;
    replica: string;
    seq: number;
    forBob: boolean;
    forAda: boolean;
  }[] = [];
  answer: 'applied' | 'parked' | 'dropped' = 'applied';
  pending: DocBody[] = [];
  publishedBatches: string[][] = [];
  dropped: { replica: string; seq: number; reason: 'overflow' | 'revoked' }[] =
    [];
  droppedBodies: JsonValue[] = [];
  passes = 0;

  applyDocOp(
    op: { replica: string; seq: number; hlc: string; body: DocBody },
    ctx: { speaksFor(replica: string, address: string): boolean }
  ): 'applied' | 'parked' | 'dropped' {
    this.seen.push({
      title: op.body.meta?.title ?? '',
      replica: op.replica,
      seq: op.seq,
      forBob: ctx.speaksFor(op.replica, 'human:bob'),
      forAda: ctx.speaksFor(op.replica, 'human:ada'),
    });
    return this.answer;
  }
  pendingDocOps(): DocBody[] {
    return [...this.pending];
  }
  published(bodies: readonly DocBody[]): void {
    this.publishedBatches.push(bodies.map((b) => b.meta?.title ?? ''));
    this.pending = [];
  }
  parkedDropped(
    meta: { replica: string; seq: number; reason: 'overflow' | 'revoked' },
    body: JsonValue
  ): void {
    this.dropped.push(meta);
    this.droppedBodies.push(body);
  }
  passComplete(): void {
    this.passes += 1;
  }
}

/** A meta-only doc op body named `title`, as a test's marker. */
export function marker(title: string, by = 'human:bob'): DocBody {
  return {
    doc: 'doc-01K3Z9R0000000000000000001',
    kind: 'put',
    by,
    meta: { title },
  };
}
