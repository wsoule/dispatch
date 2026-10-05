import type { SubagentEvent, SubagentStatus } from '@dispatch-foo/core';

import type { NormalizedEntry } from '../types.js';

// The tool names Claude Code spawns a sub-agent under. `Task` is the original
// name; newer CLIs call it `Agent`. Both take the same input shape.
const SPAWN_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent']);

/** True when a tool_use block is the agent spawning a sub-agent. */
export function isSubagentSpawn(toolName: string): boolean {
  return SPAWN_TOOLS.has(toolName);
}

// The SDK `system` subtypes that report a sub-agent's life. Each carries the
// SDK's own `task_id`; `tool_use_id` is the spawning tool call and is optional
// on the wire, which is why the tracker remembers the pairing itself.
interface TaskLifecycleMessage {
  type: 'system';
  subtype: string;
  task_id?: string;
  tool_use_id?: string;
  description?: string;
  subagent_type?: string;
  task_type?: string;
  status?: string | null;
  summary?: string;
  last_tool_name?: string;
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
  patch?: { status?: string; error?: string };
}

// The fields this reads off the Agent tool's structured result
// (`SDKUserMessage.tool_use_result`, shape AgentToolCompletedOutput). Read
// defensively: the SDK marks it `unknown` and older CLIs omit it.
interface AgentToolResult {
  totalToolUseCount?: number;
  totalTokens?: number;
  totalDurationMs?: number;
  status?: string;
}

/** Statuses the SDK's notification/update messages use, mapped to ours. */
function statusFromSdk(
  value: string | null | undefined
): SubagentStatus | null {
  switch (value) {
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'stopped':
    case 'killed':
      return 'stopped';
    default:
      return null;
  }
}

function usageFields(
  usage: TaskLifecycleMessage['usage']
): Pick<SubagentEvent, 'toolUses' | 'tokens' | 'durationMs'> {
  if (usage === undefined) return {};
  return {
    ...(usage.tool_uses !== undefined ? { toolUses: usage.tool_uses } : {}),
    ...(usage.total_tokens !== undefined ? { tokens: usage.total_tokens } : {}),
    ...(usage.duration_ms !== undefined
      ? { durationMs: usage.duration_ms }
      : {}),
  };
}

function stringField(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Turns the SDK's scattered sub-agent signals into `kind: 'agent'` entries
 * keyed by one stable id — the spawning tool_use id.
 *
 * The signals arrive on three different message types and only some of them
 * name the tool_use: the `Task`/`Agent` tool_use block itself (always first,
 * always carries the id and the prompt), `system` messages (`task_started`,
 * `task_progress`, `task_notification`, `task_updated`) keyed by the SDK's
 * task id with the tool_use id optional, and finally the tool_result on a
 * `user` message once the sub-agent's report comes back. The tracker keeps
 * the task-id-to-tool_use-id pairing and remembers which sub-agents already
 * finished, so readers see exactly one started entry, any progress, and one
 * finished entry per sub-agent no matter which signals a given CLI version
 * emits or in what order they cross.
 */
export class SubagentTracker {
  private readonly byTaskId = new Map<string, string>();
  private readonly spawned = new Map<
    string,
    { label?: string; type?: string }
  >();
  private readonly finished = new Set<string>();

  /** The started entry for a spawning tool_use block. */
  onSpawn(
    block: { id?: string; name: string; input?: unknown },
    ts: string,
    parentToolUseId: string | undefined
  ): NormalizedEntry | null {
    if (block.id === undefined) return null;
    const label = stringField(block.input, 'description');
    const type = stringField(block.input, 'subagent_type');
    this.spawned.set(block.id, { label, type });
    return this.entry(
      block.id,
      ts,
      {
        phase: 'started',
        status: 'running',
        ...(label !== undefined ? { label } : {}),
        ...(type !== undefined ? { type } : {}),
      },
      { toolName: block.name, toolInput: block.input, parentToolUseId }
    );
  }

  /** The entry a `system` lifecycle message amounts to, or `null` for any other message. */
  onSystem(message: TaskLifecycleMessage, ts: string): NormalizedEntry | null {
    switch (message.subtype) {
      case 'task_started':
        return this.onTaskStarted(message, ts);
      case 'task_progress':
        return this.onTaskProgress(message, ts);
      case 'task_notification':
        return this.onTaskNotification(message, ts);
      case 'task_updated':
        return this.onTaskUpdated(message, ts);
      default:
        return null;
    }
  }

  /**
   * The finished entry for a tool_result answering a spawn, when the SDK's
   * own notification has not already ended it. `isError` is the block's
   * flag; `result` is the structured Agent tool output when present.
   */
  onToolResult(
    block: { tool_use_id?: string; is_error?: boolean },
    result: unknown,
    ts: string
  ): NormalizedEntry | null {
    const id = block.tool_use_id;
    if (id === undefined || !this.spawned.has(id)) return null;
    const totals = (result ?? {}) as AgentToolResult;
    const status: SubagentStatus =
      block.is_error === true
        ? 'failed'
        : (statusFromSdk(totals.status) ?? 'done');
    return this.finish(id, ts, {
      status,
      ...(totals.totalToolUseCount !== undefined
        ? { toolUses: totals.totalToolUseCount }
        : {}),
      ...(totals.totalTokens !== undefined
        ? { tokens: totals.totalTokens }
        : {}),
      ...(totals.totalDurationMs !== undefined
        ? { durationMs: totals.totalDurationMs }
        : {}),
    });
  }

  private onTaskStarted(
    message: TaskLifecycleMessage,
    ts: string
  ): NormalizedEntry | null {
    // Only sub-agents: shell tasks, monitors and workflows also announce
    // themselves this way, and they are not agents.
    if (message.task_type !== undefined && message.task_type !== 'subagent') {
      return null;
    }
    const id = this.resolveId(message);
    if (id === null) return null;
    if (this.spawned.has(id)) {
      // The tool_use block already produced the started entry; this only
      // confirms the pairing (done in resolveId). Nothing new to log.
      return null;
    }
    // A start with no preceding tool_use block (a CLI that reports tasks but
    // whose spawn call this run never saw): it is still a sub-agent.
    this.spawned.set(id, {
      label: message.description,
      type: message.subagent_type,
    });
    return this.entry(id, ts, {
      phase: 'started',
      status: 'running',
      ...(message.description !== undefined
        ? { label: message.description }
        : {}),
      ...(message.subagent_type !== undefined
        ? { type: message.subagent_type }
        : {}),
    });
  }

  private onTaskProgress(
    message: TaskLifecycleMessage,
    ts: string
  ): NormalizedEntry | null {
    const id = this.resolveId(message);
    if (id === null || !this.spawned.has(id) || this.finished.has(id)) {
      return null;
    }
    return this.entry(id, ts, {
      phase: 'progress',
      status: 'running',
      ...usageFields(message.usage),
      ...(message.last_tool_name !== undefined
        ? { lastTool: message.last_tool_name }
        : {}),
      ...(message.summary !== undefined ? { summary: message.summary } : {}),
    });
  }

  private onTaskNotification(
    message: TaskLifecycleMessage,
    ts: string
  ): NormalizedEntry | null {
    const id = this.resolveId(message);
    if (id === null || !this.spawned.has(id)) return null;
    return this.finish(id, ts, {
      status: statusFromSdk(message.status) ?? 'done',
      ...usageFields(message.usage),
      ...(message.summary !== undefined ? { summary: message.summary } : {}),
    });
  }

  private onTaskUpdated(
    message: TaskLifecycleMessage,
    ts: string
  ): NormalizedEntry | null {
    const status = statusFromSdk(message.patch?.status);
    if (status === null) return null;
    const id = this.resolveId(message);
    if (id === null || !this.spawned.has(id)) return null;
    return this.finish(id, ts, {
      status,
      ...(message.patch?.error !== undefined
        ? { summary: message.patch.error }
        : {}),
    });
  }

  // The spawning tool_use id for a lifecycle message: the message's own when
  // it carries one (remembering the pairing for the ones that will not), else
  // whatever an earlier message paired its task id with.
  private resolveId(message: TaskLifecycleMessage): string | null {
    if (message.tool_use_id !== undefined) {
      if (message.task_id !== undefined) {
        this.byTaskId.set(message.task_id, message.tool_use_id);
      }
      return message.tool_use_id;
    }
    if (message.task_id === undefined) return null;
    return this.byTaskId.get(message.task_id) ?? null;
  }

  // One finished entry per sub-agent: the SDK notification, a task_updated
  // patch and the tool_result can all report the same end, and the first one
  // to arrive wins.
  private finish(
    id: string,
    ts: string,
    fields: Omit<SubagentEvent, 'id' | 'phase'>
  ): NormalizedEntry | null {
    if (this.finished.has(id)) return null;
    this.finished.add(id);
    return this.entry(id, ts, { phase: 'finished', ...fields });
  }

  private entry(
    id: string,
    ts: string,
    fields: Omit<SubagentEvent, 'id'>,
    extra: Pick<
      NormalizedEntry,
      'toolName' | 'toolInput' | 'parentToolUseId'
    > = {}
  ): NormalizedEntry {
    const known = this.spawned.get(id);
    const agent: SubagentEvent = {
      id,
      ...fields,
      // Every event repeats the label/type it knows, so a reader that only
      // ever sees the tail of a transcript can still name the sub-agent.
      ...(fields.label === undefined && known?.label !== undefined
        ? { label: known.label }
        : {}),
      ...(fields.type === undefined && known?.type !== undefined
        ? { type: known.type }
        : {}),
    };
    return {
      ts,
      kind: 'agent',
      toolUseId: id,
      agent,
      ...(extra.toolName !== undefined ? { toolName: extra.toolName } : {}),
      ...(extra.toolInput !== undefined ? { toolInput: extra.toolInput } : {}),
      ...(extra.parentToolUseId !== undefined
        ? { parentToolUseId: extra.parentToolUseId }
        : {}),
    };
  }
}
