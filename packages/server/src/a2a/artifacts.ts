import type { TaskFacts } from '@dispatch/a2a';
import { diffstatFromPatch, evidenceFact, prFact } from '@dispatch/a2a';

import { runKind } from '../orchestrator/types.js';
import type { BridgeDeps } from './port.js';

// The latest execute run's PR, diffstat and evidence, and nothing else (Q12);
// `taskStatus` is the task's canonical status, so `landed` marks the PR merged.
export function workFacts(
  deps: BridgeDeps,
  taskId: string,
  taskStatus: string
): TaskFacts['work'] {
  const run = deps.runs
    .list()
    .filter((r) => r.taskId === taskId && runKind(r) === 'execute')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  if (run === undefined) return {};
  const work: TaskFacts['work'] = {};
  if (run.prUrl !== undefined) {
    const pr = prFact(run.prUrl, {
      landed: taskStatus === 'landed',
      open: deps.prOpen(run.prUrl),
    });
    if (pr !== null) work.pr = pr;
  }
  const patch = deps.runPatch(run.id);
  if (patch !== null) work.diffstat = diffstatFromPatch(patch);
  const evidence = deps.runEvidence(run.id);
  if (evidence.length > 0) work.evidence = evidenceFact(evidence);
  return work;
}
