import { untrustedInline } from '@dispatch-foo/core';
import { reaches, sharedScopesFor } from '@dispatch/memory';
import type {
  MemoryEngine,
  MemoryEntry,
  MemoryHost,
  Principal,
} from '@dispatch/memory';

import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { runKind } from '../orchestrator/types.js';

const DIGEST_TITLE_CHARS = 80;

// The line a live run hears at its next step: kind, author, the title on one
// line cut to 80 characters, and the handle to read it by.
export function liveDigest(entry: MemoryEntry): string {
  const title = Array.from(untrustedInline(entry.title))
    .slice(0, DIGEST_TITLE_CHARS)
    .join('');
  return `🧠 memory · ${entry.kind} from ${entry.author}: ${title} (${entry.handle})`;
}

// Tells every live execute run the new shared entry reaches, except its
// author's, and returns how many heard it. A run that cannot take the
// digest is logged and skipped.
export function notifyLiveRuns(
  deps: {
    orchestrator: Pick<Orchestrator, 'list' | 'notifyRun'>;
    engine: MemoryEngine;
    host: MemoryHost;
  },
  entry: MemoryEntry,
  authorRun: string | null
): number {
  const scope = entry.scope;
  if (scope === 'personal') return 0;
  const projectKey = deps.host.projectKey();
  let reached = 0;
  for (const run of deps.orchestrator.list()) {
    if (run.state !== 'running' && run.state !== 'awaiting-approval') continue;
    if (runKind(run) !== 'execute' || run.id === authorRun) continue;
    const principal: Principal = {
      address: `run:${run.id}`,
      canDecide: false,
      kind: 'run',
    };
    // An A2A run reads team memory only.
    if (!sharedScopesFor(deps.engine.viewer(principal)).includes(scope))
      continue;
    const ctx = deps.host.taskContext(run.taskId);
    const rankCtx = { taskId: run.taskId, epic: ctx?.epic ?? null };
    if (!reaches(entry, rankCtx, projectKey)) continue;
    try {
      deps.orchestrator.notifyRun(run.id, liveDigest(entry));
      reached++;
    } catch (err) {
      console.error(`memory: run ${run.id} did not hear ${entry.handle}`, err);
    }
  }
  return reached;
}
