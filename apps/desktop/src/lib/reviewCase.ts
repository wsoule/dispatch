import type { CommandEvidence, MutationEvidence } from '@dispatch/core/browser';

/**
 * What the implementing agent's own record of its work adds up to.
 *
 * Agents record this for a reviewer to read — see `record_evidence` and
 * `record_mutation` in packages/mcp/src/tools.ts, whose own descriptions say
 * the reviewer sees it "as data, not a claim".
 */
export interface CaseSummary {
  commands: number;
  failedCommands: number;
  deadGuards: number;
  /** False when the agent recorded nothing at all — an absence the reviewer
   *  should weigh, kept distinct from "everything passed". */
  hasEvidence: boolean;
}

/** A guard whose removal broke no tests is dead code, or the test meant to
 *  protect it is vacuous. Either way it is not protecting anything. */
export function isDeadGuard(mutation: MutationEvidence): boolean {
  return mutation.testsFailed === 0;
}

export function summarizeCase(
  evidence: CommandEvidence[],
  mutations: MutationEvidence[]
): CaseSummary {
  return {
    commands: evidence.length,
    failedCommands: evidence.filter((e) => e.exitCode !== 0).length,
    deadGuards: mutations.filter(isDeadGuard).length,
    hasEvidence: evidence.length > 0 || mutations.length > 0,
  };
}

/**
 * What approving would wave through, phrased for the verdict bar. An empty
 * list means the agent's own account raised nothing — which is different from
 * it having no account, the case `hasEvidence` reports first.
 */
export function caseWarnings(summary: CaseSummary): string[] {
  if (!summary.hasEvidence) return ['no recorded verification'];
  const warnings: string[] = [];
  if (summary.failedCommands > 0) {
    warnings.push(
      `${summary.failedCommands} failed command${summary.failedCommands === 1 ? '' : 's'}`
    );
  }
  if (summary.deadGuards > 0) {
    warnings.push(
      `${summary.deadGuards} dead guard${summary.deadGuards === 1 ? '' : 's'}`
    );
  }
  return warnings;
}
