import { migrateLegacyMilestones } from '@dispatch-foo/core';

import type { ApiContext } from '../api.js';
import { statusModelFor } from '../statuses.js';
import { requestActor } from './caller.js';
import { errorResponse, jsonResponse, readJsonBodyOptional } from './http.js';

// POST /api/migrations/milestones — `{ dryRun?: boolean }`. Turns every
// legacy `milestone` string into a project task and reparents the unparented
// tasks carrying it (core's milestoneMigration.ts), answering with the
// count-parity report. The daemon is the single writer, so the CLI routes
// here whenever one is running. It only creates tasks and sets parents, which
// any credential that may write tasks can already do one at a time.
export async function migrateMilestones(
  req: Request,
  ctx: Pick<
    ApiContext,
    'rootDir' | 'store' | 'cache' | 'events' | 'caller' | 'actorContext'
  >
): Promise<Response> {
  const parsed = await readJsonBodyOptional(req);
  if (!parsed.ok) return parsed.response;
  const body = (parsed.value ?? {}) as { dryRun?: unknown };
  if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
    return errorResponse(400, 'invalid dryRun: expected a boolean');
  }
  const dryRun = body.dryRun === true;
  const report = migrateLegacyMilestones(ctx.store, {
    dryRun,
    status: statusModelFor(ctx.rootDir).roles.ready,
    creator: requestActor(ctx),
  });
  if (
    !dryRun &&
    (report.projectsCreated.length > 0 || report.reparented.length > 0)
  ) {
    const ids = [
      ...report.projectsCreated,
      ...report.reparented.map((r) => r.id),
    ];
    ctx.cache.refresh(ctx.store, ids);
    ctx.events.broadcast({ type: 'task.changed', ids });
  }
  return jsonResponse(report);
}
