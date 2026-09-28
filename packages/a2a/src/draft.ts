import type { CreateInput } from '@dispatch/core';
import {
  untrustedBlock,
  untrustedFenced,
  untrustedInline,
} from '@dispatch/core';
import type { Address } from '@dispatch/protocol';

import type { WorkRequestV1 } from './ext.js';

export type HandoffRequest = Extract<WorkRequestV1, { skill: 'handoff' }>;

export const PROVENANCE_PREFIX = 'Requested over A2A by ';
const CLIENT_PRIORITIES = new Set(['medium', 'low', 'none']);

export function provenanceLine(client: Address, rootId: string): string {
  return `${PROVENANCE_PREFIX}${client} (message ${rootId}).`;
}

// Whether a task looks like an A2A draft without asking a2a.db; used only to
// fail closed when that file cannot be opened.
export function hasA2AProvenance(
  task: { meta: { labels: readonly string[] }; body: string } | null
): boolean {
  return (
    task !== null &&
    (task.meta.labels.includes('a2a') || task.body.includes(PROVENANCE_PREFIX))
  );
}

// A client label, namespaced so it cannot collide with one the owner's
// automation keys on.
function clientLabel(raw: string): string {
  return `a2a/${raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 50)}`;
}

// The draft a handoff becomes: fenced client text with headings escaped,
// critical risk, a priority that cannot jump the owner's queue, namespaced labels.
export function shapeDraft(
  work: HandoffRequest,
  text: string,
  client: Address,
  rootId: string
): CreateInput {
  const acceptance = work.acceptance ?? [];
  const description = [
    untrustedFenced('A2A request', untrustedBlock(text)),
    ...(acceptance.length === 0
      ? []
      : [
          '',
          'Acceptance criteria:',
          ...acceptance.map((a) => `- ${untrustedInline(a)}`),
        ]),
    '',
    provenanceLine(client, rootId),
  ].join('\n');
  const labels = (work.labels ?? [])
    .map(clientLabel)
    .filter((l) => l !== 'a2a/');
  return {
    title: untrustedInline(work.title),
    status: 'draft',
    description,
    labels: [...new Set(['a2a', ...labels])],
    ...(work.writes === undefined ? {} : { writes: work.writes }),
    priority:
      work.priority !== undefined && CLIENT_PRIORITIES.has(work.priority)
        ? work.priority
        : 'medium',
    risk: 'critical',
    assignee: 'agent',
  };
}
