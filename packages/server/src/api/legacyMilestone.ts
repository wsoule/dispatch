import { canonicalKind, resolveMilestoneRef } from '@dispatch/core';

import type { ApiContext } from '../api.js';

// Tasks no longer store the free-form `milestone` string: their container is
// `parent`. A caller that still sends one (an old desktop build, a script,
// the MCP `milestone` input) names the container it means, and this turns
// that name into the parent the task is written with.

export type LegacyMilestoneResult =
  | { ok: true; parent?: string }
  | { ok: false; error: string };

/**
 * The parent a request's legacy `milestone` stands for. Absent or null is
 * nothing to do; a string must name exactly one project or milestone (by id
 * or title) that may hold a `childKind`, and agree with any `parent` sent
 * beside it.
 */
export function legacyMilestoneParent(
  ctx: Pick<ApiContext, 'cache'>,
  body: Record<string, unknown>,
  childKind: string
): LegacyMilestoneResult {
  const value = body.milestone;
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== 'string') {
    return {
      ok: false,
      error: 'invalid milestone: expected a project or milestone title',
    };
  }
  const candidates = [
    ...ctx.cache.queryMeta({ kind: 'milestone', includeArchived: true }),
    ...ctx.cache.queryMeta({ kind: 'project', includeArchived: true }),
  ];
  const resolved = resolveMilestoneRef(candidates, value, {
    childKind: canonicalKind(childKind),
    parent: typeof body.parent === 'string' ? body.parent : null,
  });
  return resolved.ok ? { ok: true, parent: resolved.id } : resolved;
}

/** `input` without its `milestone` key, which the store must never write. */
export function withoutLegacyMilestone<T extends { milestone?: unknown }>(
  input: T
): Omit<T, 'milestone'> {
  const copy = { ...input };
  delete copy.milestone;
  return copy;
}
