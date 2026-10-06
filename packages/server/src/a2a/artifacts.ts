import type { TaskFacts } from '@dispatch-foo/a2a';
import { diffstatFromPatch, evidenceFact, prFact } from '@dispatch-foo/a2a';

import type { RunMeta } from '../orchestrator/types.js';
import { runKind, TERMINAL_RUN_STATES } from '../orchestrator/types.js';
import type { BridgeDeps } from './port.js';

type RunResults = Pick<TaskFacts['work'], 'diffstat' | 'evidence'>;

// Each task's latest settled run's results until that run's meta changes: its
// diff runs git on the event loop, and its evidence parses the transcript.
export class RunResultsMemo {
  private readonly byTask = new Map<
    string,
    { key: string; results: RunResults }
  >();

  read(run: RunMeta, load: () => RunResults): RunResults {
    const key = `${run.id}|${run.state}|${run.updatedAt}`;
    const hit = this.byTask.get(run.taskId);
    if (hit?.key === key) return hit.results;
    const results = load();
    this.byTask.set(run.taskId, { key, results });
    return results;
  }
}

function runResults(deps: BridgeDeps, runId: string): RunResults {
  const results: RunResults = {};
  const patch = deps.runPatch(runId);
  if (patch !== null) results.diffstat = diffstatFromPatch(patch);
  const evidence = deps.runEvidence(runId);
  if (evidence.length > 0) results.evidence = evidenceFact(evidence);
  return results;
}

// The latest execute run's PR, diffstat and evidence, the only run results
// allowed off the machine; a live run's diff and evidence wait until it settles.
export function workFacts(
  deps: BridgeDeps,
  taskId: string,
  landed: boolean
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
      landed,
      open: deps.prOpen(run.prUrl),
    });
    if (pr !== null) work.pr = pr;
  }
  if (!TERMINAL_RUN_STATES.has(run.state)) return work;
  return {
    ...work,
    ...deps.runResults.read(run, () => runResults(deps, run.id)),
  };
}
