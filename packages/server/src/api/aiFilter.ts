import { isContainer, loadConfig, parentIdsOf } from '@dispatch-foo/core';

import {
  type AiFilterVocabulary,
  type AiTaskFilterPort,
  ClaudeAiTaskFilter,
} from '../aiTaskFilter.js';
import type { TaskCache } from '../cache.js';
import type { RunState } from '../orchestrator/types.js';
import { errorResponse, jsonResponse, readJsonBody } from './http.js';

// The slice of ApiContext this route reads, so a test can hand it a fake cache
// without booting a daemon.
export interface AiFilterRouteContext {
  rootDir: string;
  cache: Pick<TaskCache, 'query'>;
  aiTaskFilter?: AiTaskFilterPort;
}

// Every `RunState`, not just the ones with a live run: "tasks an agent is
// working on" must still sanitize to `run is running` when nothing is running.
const RUN_STATES: RunState[] = [
  'provisioning',
  'running',
  'awaiting-approval',
  'finished',
  'failed',
  'cancelled',
  'interrupted-dirty',
];

// A sentence is a line typed into a menu; anything longer is spliced verbatim
// into a paid model prompt for nothing.
const MAX_SENTENCE = 500;

// The project's live filter vocabulary, read from the cache (never the task
// files) so the SQLite and markdown backends answer the same thing.
function vocabularyFor(ctx: AiFilterRouteContext): AiFilterVocabulary {
  const docs = ctx.cache.query({ includeArchived: false });
  const labels = new Set<string>();
  const milestones = new Set<string>();
  const epics: AiFilterVocabulary['epics'] = [];
  const parentIds = parentIdsOf(docs);
  for (const doc of docs) {
    for (const label of doc.meta.labels) labels.add(label);
    if (doc.meta.milestone !== null) milestones.add(doc.meta.milestone);
    if (isContainer(doc.meta, parentIds)) {
      epics.push({ id: doc.meta.id, title: doc.meta.title });
    }
  }
  return {
    statuses: [...loadConfig(ctx.rootDir).statuses],
    labels: [...labels].sort(),
    milestones: [...milestones].sort(),
    epics,
    runStates: [...RUN_STATES],
  };
}

// POST /api/tasks/ai-filter — turns `{ sentence }` into filter clauses the
// Tasks page applies as chips.
export async function aiFilterTasks(
  req: Request,
  ctx: AiFilterRouteContext
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const sentence = (parsed.value as { sentence?: unknown }).sentence;
  if (typeof sentence !== 'string' || sentence.trim() === '') {
    return errorResponse(400, 'sentence is required');
  }
  if (sentence.length > MAX_SENTENCE) {
    return errorResponse(400, 'sentence is too long');
  }
  const port = ctx.aiTaskFilter ?? new ClaudeAiTaskFilter(ctx.rootDir);
  try {
    return jsonResponse(await port.toFilters(sentence, vocabularyFor(ctx)));
  } catch (err) {
    return errorResponse(502, (err as Error).message);
  }
}
