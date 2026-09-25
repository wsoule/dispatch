import type {
  Address,
  DeliveryEngine,
  GateData,
  JsonValue,
  Message,
} from '@dispatch/protocol';

import { untrustedInline } from '../orchestrator/prompt.js';
import type {
  ApprovalDecision,
  ApprovalGateRequest,
} from '../orchestrator/types.js';
import {
  OrchestratorClientError,
  OrchestratorConflictError,
  OrchestratorNotFoundError,
} from '../orchestrator/types.js';
import { describeToolInput } from '../policyEngine.js';
import { SYSTEM_SENDER } from './gates.js';

export const TOOL_INPUT_PREVIEW_BYTES = 8192;
const TOOL_APPROVAL_CHOICES = ['approve', 'approve-session', 'deny'] as const;

// A tool call's input as its gate shows it: whole when its JSON fits in
// 8 KiB, else that text cut on a code point and marked truncated.
export function previewToolInput(input: unknown): {
  input: JsonValue;
  truncated?: true;
} {
  let json: string | undefined;
  try {
    json = JSON.stringify(input);
  } catch {
    json = undefined;
  }
  if (
    json !== undefined &&
    Buffer.byteLength(json) <= TOOL_INPUT_PREVIEW_BYTES
  ) {
    return { input: JSON.parse(json) as JsonValue };
  }
  const text = json ?? String(input);
  if (Buffer.byteLength(text) <= TOOL_INPUT_PREVIEW_BYTES)
    return { input: text };
  let out = '';
  let bytes = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > TOOL_INPUT_PREVIEW_BYTES) break;
    bytes += size;
    out += ch;
  }
  return { input: out, truncated: true };
}

// Asks the project owner about one parked tool call.
export async function raiseToolApproval(
  engine: DeliveryEngine,
  owner: Address,
  request: ApprovalGateRequest
): Promise<Message> {
  const preview = previewToolInput(request.input);
  const data = {
    type: 'tool-approval',
    requestId: request.requestId,
    runId: request.runId,
    tool: request.toolName,
    ...preview,
  } satisfies GateData;
  const { message } = await engine.send(
    {
      to: [owner],
      kind: 'question',
      blocking: true,
      choices: [...TOOL_APPROVAL_CHOICES],
      body: `${untrustedInline(request.taskTitle)} wants to run ${request.toolName}: ${describeToolInput(preview.input)}`,
      refs: [
        { type: 'run', id: request.runId },
        { type: 'task', id: request.taskId },
      ],
      data,
    },
    SYSTEM_SENDER
  );
  return message;
}

// The decision an answer to a tool-approval gate stands for.
export function toolApprovalDecision(
  answer: Pick<Message, 'choice' | 'body'>
): ApprovalDecision {
  if (answer.choice === 'deny') {
    const reason = answer.body.trim();
    return reason === '' ? { allow: false } : { allow: false, reason };
  }
  return {
    allow: true,
    scope: answer.choice === 'approve-session' ? 'session' : 'once',
  };
}

// True for the errors approve() throws once its run has moved on.
export function isStaleApproval(err: unknown): boolean {
  return (
    err instanceof OrchestratorClientError ||
    err instanceof OrchestratorNotFoundError ||
    err instanceof OrchestratorConflictError
  );
}
