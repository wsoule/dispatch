import type {
  HookCallback,
  HookJSONOutput,
  Options,
} from '@anthropic-ai/claude-agent-sdk';
import type { FloorCheck } from '@dispatch/core';

import { floorCheckForToolInput } from '../floor.js';

/** One floor-tripping tool call, held while a human decides on it. */
export interface FloorHoldRequest {
  /** Unique per tool call, so the approval flow can key its answer to it. */
  requestId: string;
  /** The tool call's own id, which canUseTool also receives for the call. */
  toolUseId: string;
  toolName: string;
  input: unknown;
  check: FloorCheck;
}

/** A human's answer to a held call; `reason` is shown to the model. */
export interface FloorHoldDecision {
  allow: boolean;
  reason?: string;
}

/**
 * How a session answers floor-tripping calls: a function that holds each one
 * for a human and resolves with their decision, or `'deny'` for a session
 * with no human to ask.
 */
export type FloorPolicy =
  | ((request: FloorHoldRequest) => Promise<FloorHoldDecision>)
  | 'deny';

// How long the CLI waits on the hook while a human decides: a week, so the
// wait is bounded only by the human (the orchestrator's own stop and cancel
// paths resolve a hold sooner). A hook that timed out failed closed: the CLI
// refused the call, even under bypassPermissions.
const FLOOR_HOLD_TIMEOUT_SECONDS = 7 * 24 * 60 * 60;

/**
 * The SDK options that hold every irreversible tool call (floor.ts: a
 * force-push, a publish, a repo-settings change, a remote ref deletion) for a
 * human in a Claude Code session, spread into that session's `query()`
 * options.
 *
 * The floor used to be enforced only inside `canUseTool`, and the Claude Code
 * CLI does not always get as far as asking it. Each of these was reproduced
 * against the bundled CLI (SDK 0.3.207) with a harmless `git push --force`:
 *
 * - Under bypassPermissions, or with a settings allow rule such as
 *   `Bash(git push:*)` in any mode, it ran without `canUseTool` being called.
 * - A settings PermissionRequest hook answering "allow" races `canUseTool`
 *   (the CLI takes whichever answers first) and beat the human every time.
 * - Plan-mode sessions with no `canUseTool` at all ran it on an allow rule.
 *
 * So the decision is made where none of that can intervene:
 *
 * - A PreToolUse hook sees every tool call first, sub-agents' included, and
 *   decides a floor-tripping one itself. With a hold policy it waits for the
 *   human and returns allow or deny. A deny is final. An allow skips the
 *   permission path unless something else still asks for it: a settings ask
 *   rule, one of the CLI's own safety checks, or another hook answering "ask"
 *   sends the call on to `canUseTool`, so a session has to recognize a call
 *   its human already approved (the executor and overseer do, by tool-use
 *   id). Without those, no PermissionRequest hook ran and `canUseTool` was
 *   not called. A settings deny rule still refused the call after a human's
 *   allow. Calls the floor does not cover get no decision, so they take the
 *   session's normal permission path unchanged. A policy that throws is a
 *   refusal: a hook that fails gives the CLI no decision, which is an allow
 *   under bypassPermissions.
 * - `CLAUDE_CODE_SIMPLE` is pinned off. Bare mode drops every hook registered
 *   through the SDK, and a repo's `.claude/settings.json` (or a
 *   `settings.local.json` an agent writes) can switch it on through its `env`
 *   block; with the hook gone, a force-push ran under bypassPermissions.
 *   These settings load into the SDK's flag layer, which outranks the user,
 *   project and local files.
 * - Inline shell in skills and custom slash commands (a `!` + backtick line in
 *   a SKILL.md) is disabled. It runs as the skill loads, reaching neither a
 *   tool hook nor `canUseTool`; a checkout's own skill ran a force-push that
 *   way. The model can still run the same command through Bash, where the
 *   hook sees it.
 *
 * `refusal` is checked ahead of the floor on every call: while it returns a
 * reason, every call is denied with that reason, floor commands included. The
 * Claude executor's graceful stop uses it, since the stop has to reach the
 * agent in the same modes where canUseTool never runs. Checking both in one
 * callback means the outcome does not depend on how the CLI merges two hooks
 * that disagree.
 */
export function floorGuard(
  policy: FloorPolicy,
  refusal: () => string | null = () => null
): Required<Pick<Options, 'hooks' | 'settings'>> {
  return {
    hooks: {
      PreToolUse: [
        {
          hooks: [floorHook(policy, refusal)],
          timeout: FLOOR_HOLD_TIMEOUT_SECONDS,
        },
      ],
    },
    settings: {
      env: { CLAUDE_CODE_SIMPLE: '0' },
      disableSkillShellExecution: true,
    },
  };
}

// The PreToolUse callback itself. It sees every tool (no matcher), because a
// command can reach the shell through any tool whose input carries one.
function floorHook(
  policy: FloorPolicy,
  refusal: () => string | null
): HookCallback {
  return async (input, toolUseId) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const refused = refusal();
    if (refused !== null) return decision('deny', refused);
    const check = floorCheckForToolInput(input.tool_input);
    if (check === null) return {};
    if (policy === 'deny') {
      return decision(
        'deny',
        `This command matches Dispatch's irreversible-action floor (${check}) and cannot run in this session, which has no human to approve it. If you only meant to find or read that text, use a search pattern or command that does not spell out the whole command.`
      );
    }
    const callId = toolUseId ?? input.tool_use_id;
    let answer: FloorHoldDecision;
    try {
      answer = await policy({
        requestId: `floor-${callId}`,
        toolUseId: callId,
        toolName: input.tool_name,
        input: input.tool_input,
        check,
      });
    } catch (err) {
      return decision(
        'deny',
        `Dispatch could not hold this irreversible action (${check}) for a human, so it was not run: ${(err as Error).message}`
      );
    }
    if (answer.allow) {
      return decision(
        'allow',
        `A human approved this irreversible action (${check}).`
      );
    }
    // The human's reason reaches the model, so a refusal arrives as an
    // explanation rather than a bare no.
    const reason = answer.reason?.trim();
    return decision(
      'deny',
      reason !== undefined && reason !== '' ? reason : 'denied by user'
    );
  };
}

// A PreToolUse decision, with the reason the CLI shows the model.
function decision(
  permissionDecision: 'allow' | 'deny',
  permissionDecisionReason: string
): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision,
      permissionDecisionReason,
    },
  };
}
