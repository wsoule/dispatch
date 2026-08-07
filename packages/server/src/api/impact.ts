import type { ApiContext } from '../api.js';
import type { ReachResult } from '../depmap.js';
import type { ImpactSubject } from '../impact.js';
import { computeImpact } from '../impact.js';
import { OrchestratorNotFoundError } from '../orchestrator/types.js';
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

// The files a run's diff touched — computeImpact's seed set for a run
// subject. `null` (not `orchestrator.diff`'s thrown error) is what tells
// computeImpact the run id is unknown, since a live/snapshotted worktree
// isn't guaranteed for a run that never had a reviewable diff.
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

// Every path git tracks in the repo, repo-relative — the universe a task's
// declared write globs are matched against.
function trackedFiles(rootDir: string): string[] {
  const result = Bun.spawnSync(['git', 'ls-files', '-z'], {
    cwd: rootDir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ls-files failed: ${result.stderr.toString('utf8').trim()}`
    );
  }
  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter((path) => path !== '');
}

// GET /api/impact?subject=file|run|task&id=<value> — the blast radius of a
// file, a run's diff, or a task's declared writes, walked over the shared
// DepMapCache so a burst of requests reuses one scan.
export function getImpact(ctx: ApiContext, url: URL): Response {
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

  const result = computeImpact(subject, {
    rootDir: ctx.rootDir,
    depMap: () => ctx.depMapCache.get(),
    changedFilesForRun: (runId) => changedFilesForRun(ctx, runId),
    writesForTask: (taskId) => writesForTask(ctx, taskId),
    trackedFiles: () => trackedFiles(ctx.rootDir),
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
