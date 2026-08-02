import type { ApiContext } from '../api.js';
import { jsonResponse } from './http.js';

// GET /api/runs/claims — every live run's current file claims, so an agent
// (or the epic scheduler) can see who's touching what without being told.
export function listRunClaims(ctx: ApiContext): Response {
  return jsonResponse(ctx.orchestrator.liveClaims());
}
