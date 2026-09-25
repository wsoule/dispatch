import { describe, expect, it } from 'bun:test';

import type {
  FloorHoldDecision,
  FloorHoldRequest,
} from '../../src/orchestrator/floorHook.js';
import { floorGuard } from '../../src/orchestrator/floorHook.js';
import { floorDecision, preToolUse } from './helpers.js';

// A stand-in for the human behind a hold: records every request it is asked
// and answers with `decision`.
function stubHuman(decision: FloorHoldDecision): {
  asked: FloorHoldRequest[];
  hold: (request: FloorHoldRequest) => Promise<FloorHoldDecision>;
} {
  const asked: FloorHoldRequest[] = [];
  return {
    asked,
    hold: (request) => {
      asked.push(request);
      return Promise.resolve(decision);
    },
  };
}

describe('floorGuard', () => {
  // The hook decides a floor command itself, after the human answers, rather
  // than answering "ask": against the bundled CLI an "ask" entered a
  // permission path where a settings PermissionRequest hook answering
  // "allow" beat the human to it.
  it('holds every floor command for a human and applies their approval', async () => {
    const human = stubHuman({ allow: true });
    const hooks = floorGuard(human.hold).hooks;
    for (const command of [
      'git push --force origin main',
      'npm publish',
      'git push origin v1.2.3',
      'gh repo edit --visibility public',
      'git push origin --delete feature',
    ]) {
      expect(await floorDecision(hooks, 'Bash', { command })).toBe('allow');
    }
    // The tool's name is not what decides: a renamed shell tool still counts.
    expect(
      await floorDecision(hooks, 'mcp__shell__run', {
        command: 'git push -f origin main',
      })
    ).toBe('allow');
    expect(human.asked).toHaveLength(6);
    expect(human.asked[0]).toEqual({
      requestId: 'floor-tu-1',
      toolUseId: 'tu-1',
      toolName: 'Bash',
      input: { command: 'git push --force origin main' },
      check: 'force-push',
    });
    expect(human.asked.map((request) => request.check)).toEqual([
      'force-push',
      'publish',
      'publish',
      'repo-settings',
      'delete-outside-writes',
      'force-push',
    ]);
  });

  it("passes a human's refusal and its reason on to the model", async () => {
    expect(
      await preToolUse(
        floorGuard(stubHuman({ allow: false, reason: ' not today ' }).hold)
          .hooks,
        'Bash',
        { command: 'npm publish' }
      )
    ).toMatchObject({
      permissionDecision: 'deny',
      permissionDecisionReason: 'not today',
    });
    expect(
      await preToolUse(
        floorGuard(stubHuman({ allow: false }).hold).hooks,
        'Bash',
        { command: 'npm publish' }
      )
    ).toMatchObject({
      permissionDecision: 'deny',
      permissionDecisionReason: 'denied by user',
    });
  });

  // A hook that fails gives the CLI no decision, which bypassPermissions
  // treats as an allow, so a hold that cannot be raised has to be a refusal.
  it('refuses the call when the hold itself fails', async () => {
    const decision = await preToolUse(
      floorGuard(() => Promise.reject(new Error('approval store down'))).hooks,
      'Bash',
      { command: 'git push --force origin main' }
    );
    expect(decision?.permissionDecision).toBe('deny');
    expect(String(decision?.permissionDecisionReason)).toContain(
      'approval store down'
    );
  });

  it('denies floor commands outright in a session with no human to ask', async () => {
    const decision = await preToolUse(floorGuard('deny').hooks, 'Bash', {
      command: 'cargo publish',
    });
    expect(decision?.permissionDecision).toBe('deny');
    // The reason names the floor check.
    expect(String(decision?.permissionDecisionReason)).toContain('publish');
  });

  it('gives no decision, and asks no one, for anything the floor does not cover', async () => {
    const human = stubHuman({ allow: true });
    const hooks = floorGuard(human.hold).hooks;
    // No decision (not "allow"): the call takes the session's normal path.
    expect(
      await floorDecision(hooks, 'Bash', { command: 'git push origin HEAD' })
    ).toBeUndefined();
    expect(
      await floorDecision(hooks, 'Edit', { file_path: 'a.ts' })
    ).toBeUndefined();
    expect(await floorDecision(hooks, 'Read', null)).toBeUndefined();
    expect(human.asked).toEqual([]);
  });

  it('denies every call with the refusal reason while there is one, floor or not', async () => {
    let reason: string | null = null;
    const human = stubHuman({ allow: true });
    const hooks = floorGuard(human.hold, () => reason).hooks;
    expect(await floorDecision(hooks, 'Edit', { file_path: 'a.ts' })).toBe(
      undefined
    );
    expect(await floorDecision(hooks, 'Bash', { command: 'npm publish' })).toBe(
      'allow'
    );

    reason = 'stop now';
    for (const [toolName, toolInput] of [
      ['Edit', { file_path: 'a.ts' }],
      ['Read', null],
      ['Bash', { command: 'npm publish' }],
    ] as const) {
      expect(await preToolUse(hooks, toolName, toolInput)).toMatchObject({
        permissionDecision: 'deny',
        permissionDecisionReason: 'stop now',
      });
    }
    // Refused ahead of the floor, so the human is not asked again.
    expect(human.asked).toHaveLength(1);
  });

  it('gives no decision for events other than PreToolUse', async () => {
    const hook = floorGuard('deny').hooks.PreToolUse?.[0]?.hooks[0];
    const output = await hook?.(
      {
        hook_event_name: 'PostToolUse',
        tool_input: { command: 'npm publish' },
      } as never,
      undefined,
      { signal: new AbortController().signal }
    );
    expect(output).toEqual({});
  });

  // No matcher: a command can reach the shell through any tool whose input
  // carries one, so the hook has to see every tool call. The timeout lets a
  // human take their time; a hook that times out fails closed.
  it('hooks every tool, with no matcher narrowing it, and waits days for a human', () => {
    const matchers = floorGuard('deny').hooks.PreToolUse ?? [];
    expect(matchers).toHaveLength(1);
    expect(matchers[0]?.matcher).toBeUndefined();
    expect(matchers[0]?.timeout).toBeGreaterThanOrEqual(24 * 60 * 60);
  });

  // Both were verified against the bundled CLI: a repo's settings `env` could
  // switch on bare mode, which drops SDK hooks, and a SKILL.md's inline shell
  // ran a force-push without reaching any hook or canUseTool.
  it('pins bare mode off and disables inline skill shell in the flag settings layer', () => {
    for (const policy of [stubHuman({ allow: true }).hold, 'deny'] as const) {
      expect(floorGuard(policy).settings).toEqual({
        env: { CLAUDE_CODE_SIMPLE: '0' },
        disableSkillShellExecution: true,
      });
    }
  });
});
