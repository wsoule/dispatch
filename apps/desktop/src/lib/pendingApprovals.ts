import type { Message, RunMeta } from '@dispatch/client';

import { toolApprovalOf } from './gates';

/** One tool call a run is parked on, as its card needs it: the request id its
 * answer names, the tool, and the gate's preview of the call's input. */
export interface PendingApproval {
  requestId: string;
  toolName: string;
  /** The gate's preview of the call's input, at most 8 KiB. */
  input: unknown;
  /** True when the preview was cut short of the call's full input. */
  truncated: boolean;
}

/** Every open tool-approval gate per run, oldest first: one entry per parked
 *  call. Once runs have loaded, only awaiting-approval runs count. */
export function pendingApprovalsFromGates(
  gates: readonly Message[],
  runs: RunMeta[] | undefined
): Map<string, PendingApproval[]> {
  const awaiting =
    runs === undefined
      ? null
      : new Set(
          runs.filter((r) => r.state === 'awaiting-approval').map((r) => r.id)
        );
  const byRun = new Map<string, { at: string; approval: PendingApproval }[]>();
  for (const message of gates) {
    const gate = toolApprovalOf(message);
    const runId = gate?.runId;
    if (gate === null || runId === undefined) continue;
    if (awaiting !== null && !awaiting.has(runId)) continue;
    const entry = {
      at: message.createdAt,
      approval: {
        requestId: gate.requestId,
        toolName: gate.tool,
        input: gate.input,
        truncated: gate.truncated === true,
      },
    };
    const calls = byRun.get(runId);
    if (calls === undefined) byRun.set(runId, [entry]);
    else calls.push(entry);
  }
  const approvals = new Map<string, PendingApproval[]>();
  for (const [runId, calls] of byRun) {
    calls.sort((a, b) => a.at.localeCompare(b.at));
    approvals.set(
      runId,
      calls.map((c) => c.approval)
    );
  }
  return approvals;
}
