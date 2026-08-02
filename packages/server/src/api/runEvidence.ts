import type { ApiContext } from '../api.js';
import { errorResponse, jsonResponse, readJsonBody } from './http.js';

// POST /api/runs/:id/evidence — a command the implementer actually ran,
// recorded instead of narrated in a report.
export async function createRunEvidence(
  req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as {
    command?: unknown;
    exitCode?: unknown;
    durationMs?: unknown;
    summary?: unknown;
  };
  if (typeof body.command !== 'string' || body.command.trim() === '') {
    return errorResponse(400, 'invalid command: command is required');
  }
  if (typeof body.exitCode !== 'number' || !Number.isInteger(body.exitCode)) {
    return errorResponse(400, 'invalid exitCode: expected an integer');
  }
  if (
    typeof body.durationMs !== 'number' ||
    !Number.isFinite(body.durationMs) ||
    body.durationMs < 0
  ) {
    return errorResponse(
      400,
      'invalid durationMs: expected a non-negative number'
    );
  }
  if (typeof body.summary !== 'string' || body.summary.trim() === '') {
    return errorResponse(400, 'invalid summary: summary is required');
  }
  try {
    const evidence = ctx.orchestrator.recordEvidence(runId, {
      command: body.command,
      exitCode: body.exitCode,
      durationMs: body.durationMs,
      summary: body.summary,
    });
    return jsonResponse(evidence, 201);
  } catch {
    return errorResponse(404, `run not found: ${runId}`);
  }
}

// POST /api/runs/:id/mutations — a mutation test result: a guard reverted,
// tests re-run. `testsFailed: 0` is the signal buildReviewPrompt flags.
export async function createRunMutation(
  req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as {
    guard?: unknown;
    file?: unknown;
    testsFailed?: unknown;
  };
  if (typeof body.guard !== 'string' || body.guard.trim() === '') {
    return errorResponse(400, 'invalid guard: guard is required');
  }
  if (typeof body.file !== 'string' || body.file.trim() === '') {
    return errorResponse(400, 'invalid file: file is required');
  }
  if (
    typeof body.testsFailed !== 'number' ||
    !Number.isInteger(body.testsFailed) ||
    body.testsFailed < 0
  ) {
    return errorResponse(
      400,
      'invalid testsFailed: expected a non-negative integer'
    );
  }
  try {
    const mutation = ctx.orchestrator.recordMutation(runId, {
      guard: body.guard,
      file: body.file,
      testsFailed: body.testsFailed,
    });
    return jsonResponse(mutation, 201);
  } catch {
    return errorResponse(404, `run not found: ${runId}`);
  }
}
