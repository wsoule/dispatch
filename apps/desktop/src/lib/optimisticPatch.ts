import type { TaskMeta, UpdatePatch } from '@dispatch/core/browser';

// The patch keys that are frontmatter, which the list cache can show before the daemon
// answers. Body sections and activity lines live in the body, which the list never holds.
const META_KEYS = [
  'title',
  'status',
  'parent',
  'milestone',
  'blockedBy',
  'labels',
  'priority',
  'assignee',
  'selfReview',
  'writes',
  'risk',
  'model',
  'external',
  'kind',
  'estimate',
  'dueDate',
  'startDate',
  'cycle',
  'relatedTo',
  'duplicateOf',
  'initiatives',
  'color',
  'icon',
] as const satisfies readonly (keyof UpdatePatch & keyof TaskMeta)[];

/** Whether a patch changes anything the task list shows. */
export function touchesMeta(patch: UpdatePatch): boolean {
  return (
    META_KEYS.some((key) => patch[key] !== undefined) ||
    patch.archivedAt !== undefined
  );
}

/** `meta` as it will read once the daemon applies `patch` — what an edit paints at once. */
export function patchedMeta(meta: TaskMeta, patch: UpdatePatch): TaskMeta {
  const next: Record<string, unknown> = { ...meta };
  for (const key of META_KEYS) {
    const value = patch[key];
    if (value !== undefined) next[key] = value;
  }
  if (patch.archivedAt === null) delete next.archivedAt;
  else if (patch.archivedAt !== undefined) next.archivedAt = patch.archivedAt;
  return next as unknown as TaskMeta;
}

/** Whether a patch rewrites the body's Description or Acceptance Criteria. */
export function touchesBody(patch: UpdatePatch): boolean {
  return (
    patch.description !== undefined || patch.acceptanceCriteria !== undefined
  );
}

// Replaces one `## <heading>` section, or inserts it before `## Activity`. Close enough to
// the daemon's setSection for display; the daemon's own body replaces it on reply.
function withSection(body: string, heading: string, content: string): string {
  const parts = body.split(/^(?=## )/m);
  const block = `## ${heading}\n\n${content.trim()}\n\n`;
  const at = parts.findIndex(
    (p) => p.split('\n', 1)[0]?.trim() === `## ${heading}`
  );
  if (at >= 0) {
    parts[at] = block;
  } else {
    const activity = parts.findIndex((p) => p.startsWith('## Activity'));
    if (activity >= 0) parts.splice(activity, 0, block);
    else parts.push(block);
  }
  return parts.join('');
}

/** `body` with a patch's Description and Acceptance Criteria applied. */
export function patchedBody(body: string, patch: UpdatePatch): string {
  let next = body;
  if (patch.description !== undefined) {
    next = withSection(next, 'Description', patch.description);
  }
  if (patch.acceptanceCriteria !== undefined) {
    next = withSection(next, 'Acceptance Criteria', patch.acceptanceCriteria);
  }
  return next;
}
