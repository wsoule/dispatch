import type { DocScope, LinkTarget, TaskRisk } from '@dispatch/core';
import type { Operator } from '@dispatch/memory';

import type { Principal } from '../messaging/principal.js';

// How DocsService reaches the rest of the daemon, so its tests run against a
// recording fake.

export interface DocsTaskFacts {
  id: string;
  title: string;
  body: string;
  parent: string | null;
  risk: TaskRisk;
  labels: string[];
}

type DocChangeKind =
  | 'created'
  | 'revised'
  | 'amended'
  | 'sealed'
  | 'meta'
  | 'deleted';

export interface DocChange {
  doc: string;
  scope: DocScope;
  kind: DocChangeKind;
  author: string;
  rev: string | null;
  summary: string;
}

export interface DocsHost {
  operatorOf(principal: Principal): Operator | null;
  // The task of an execute run; null for every other principal.
  taskOfPrincipal(principal: Principal): string | null;
  runKind(principal: Principal): 'execute' | 'review' | 'verify' | null;
  task(id: string): DocsTaskFacts | null;
  // Whether a task, run, thread root or memory entry exists; docs are checked by the service.
  exists(target: LinkTarget): boolean;
  inThread(threadId: string, principal: Principal): boolean;
  memoryScope(id: string): 'personal' | 'project' | 'team' | null;
  memoryVisible(id: string, principal: Principal): boolean;
  // Called after a write commits: events, receipts and notices hang off it.
  changed(change: DocChange): void;
  now(): Date;
}
