import {
  isLabelColor,
  loadConfig,
  updateConfig,
  withLabelColor,
} from '@dispatch-foo/core';
import type { LabelDefinition } from '@dispatch-foo/core';

import type { ApiContext } from '../api.js';
import { errorResponse, jsonResponse, readJsonBody } from './http.js';

// The label registry routes. The registry lives in config.yml (`labels:`),
// so a write broadcasts `config.changed` like any other config edit.

/** GET /api/labels's body. */
interface LabelsSnapshot {
  labels: LabelDefinition[];
}

// GET /api/labels — every label with a color or an external link.
export function listLabels(ctx: Pick<ApiContext, 'rootDir'>): Response {
  const snapshot: LabelsSnapshot = {
    labels: loadConfig(ctx.rootDir).labels ?? [],
  };
  return jsonResponse(snapshot);
}

// PUT /api/labels — `{ name, color }` sets one label's color, `color: null`
// clears it. A linked label's new color reaches Linear on the next push.
export async function putLabelColor(
  req: Request,
  ctx: Pick<ApiContext, 'rootDir' | 'events' | 'linearSync'>
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const { name, color } = parsed.value as Record<string, unknown>;
  if (typeof name !== 'string' || name.trim() === '') {
    return errorResponse(400, 'name must be a non-empty string');
  }
  if (color !== null && !isLabelColor(color)) {
    return errorResponse(
      400,
      'color must be a hex color like #5e6ad2, or null'
    );
  }
  try {
    const current = loadConfig(ctx.rootDir).labels ?? [];
    const next = updateConfig(ctx.rootDir, {
      labels: withLabelColor(current, name, color),
    });
    ctx.events.broadcast({ type: 'config.changed' });
    ctx.linearSync.notifyLabelsChanged();
    const snapshot: LabelsSnapshot = { labels: next.labels ?? [] };
    return jsonResponse(snapshot);
  } catch (err) {
    return errorResponse(400, (err as Error).message);
  }
}
