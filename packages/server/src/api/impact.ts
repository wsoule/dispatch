import type { ApiContext } from '../api.js';
import type { ReachResult } from '../depmap.js';
import type { ImpactSubject } from '../impact.js';
import { computeImpact } from '../impact.js';
import { OrchestratorNotFoundError } from '../orchestrator/types.js';
import { TrackedFilesError } from '../trackedFiles.js';
import { errorResponse, jsonResponse } from './http.js';

const SUBJECT_KINDS: readonly string[] = ['file', 'run', 'task'];

const EMPTY_REACH: ReachResult = {
  entries: [],
  count: 0,
  maxHops: 0,
  sources: [],
  degraded: false,
  truncated: false,
};

// The files a run's diff touched; null (not a thrown error) signals an
// unknown run to computeImpact.
function changedFilesForRun(ctx: ApiContext, runId: string): string[] | null {
  try {
    return ctx.orchestrator.diff(runId).files.map((file) => file.path);
  } catch (err) {
    if (err instanceof OrchestratorNotFoundError) return null;
    throw err;
  }
}

// A task's declared `writes` frontmatter, or null when the task id is unknown.
function writesForTask(ctx: ApiContext, taskId: string): string[] | null {
  const task = ctx.store.get(taskId);
  return task === null ? null : task.meta.writes;
}

// GET /api/impact?subject=file|run|task&id=<value> — the blast radius of a
// file, a run's diff, or a task's declared writes.
export async function getImpact(ctx: ApiContext, url: URL): Promise<Response> {
  const kind = url.searchParams.get('subject');
  if (kind === null || !SUBJECT_KINDS.includes(kind)) {
    return errorResponse(
      400,
      `invalid subject: ${String(kind)} (expected ${SUBJECT_KINDS.join('|')})`
    );
  }
  const id = url.searchParams.get('id');
  if (id === null || id.trim() === '') {
    return errorResponse(400, 'id is required');
  }

  const subject: ImpactSubject =
    kind === 'file'
      ? { kind: 'file', path: id }
      : kind === 'run'
        ? { kind: 'run', runId: id }
        : { kind: 'task', taskId: id };

  // Only a task with declared writes ever reaches computeImpact's
  // trackedFiles() call; peeking at the same writes avoids a wasted spawn.
  let trackedFilesValue: string[] = [];
  if (subject.kind === 'task') {
    const writes = writesForTask(ctx, subject.taskId);
    if (writes !== null && writes.length > 0) {
      try {
        trackedFilesValue = await ctx.trackedFilesCache.get();
      } catch (err) {
        if (err instanceof TrackedFilesError) {
          return errorResponse(502, err.message);
        }
        throw err;
      }
    }
  }

  const result = computeImpact(subject, {
    rootDir: ctx.rootDir,
    depMap: () => ctx.depMapCache.get(),
    changedFilesForRun: (runId) => changedFilesForRun(ctx, runId),
    writesForTask: (taskId) => writesForTask(ctx, taskId),
    trackedFiles: () => trackedFilesValue,
  });

  if (result.ok) {
    return jsonResponse({
      subject: result.subject,
      seeds: result.seeds,
      reach: result.reach,
    });
  }

  if (result.reason === 'not-found') {
    return errorResponse(404, `${kind} not found: ${id}`);
  }
  if (result.reason === 'outside-root') {
    return errorResponse(400, 'path escapes the repository root');
  }
  // 'no-declared-writes' — a task that declares nothing is a real answer,
  // not an error: it gets a 200 with an empty reach and the reason echoed.
  return jsonResponse({
    subject,
    seeds: [],
    reach: EMPTY_REACH,
    reason: result.reason,
  });
}
