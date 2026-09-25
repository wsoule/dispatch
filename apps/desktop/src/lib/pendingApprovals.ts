import type { Message, RunMeta } from '@dispatch/client';

import { toolApprovalOf } from './gates';

/** The approval a run is parked on, as the UI needs it: enough to answer it
 * and to say which tool call is being asked about. */
export interface PendingApproval {
  requestId: string;
  toolName: string;
  /** The tool call's input, when the source carried it. */
  input?: unknown;
}

/** Each run's oldest open tool-approval gate, with its input preview. Once runs
 *  have loaded, only awaiting-approval runs count. */
export function pendingApprovalsFromGates(
  gates: readonly Message[],
  runs: RunMeta[] | undefined
): Map<string, PendingApproval> {
  const awaiting =
    runs === undefined
      ? null
      : new Set(
          runs.filter((r) => r.state === 'awaiting-approval').map((r) => r.id)
        );
  const oldest = new Map<string, { at: string; approval: PendingApproval }>();
  for (const message of gates) {
    const gate = toolApprovalOf(message);
    const runId = gate?.runId;
    if (gate === null || runId === undefined) continue;
    if (awaiting !== null && !awaiting.has(runId)) continue;
    const seen = oldest.get(runId);
    if (seen !== undefined && seen.at <= message.createdAt) continue;
    oldest.set(runId, {
      at: message.createdAt,
      approval: {
        requestId: gate.requestId,
        toolName: gate.tool,
        input: gate.input,
      },
    });
  }
  const approvals = new Map<string, PendingApproval>();
  for (const [runId, { approval }] of oldest) approvals.set(runId, approval);
  return approvals;
}
