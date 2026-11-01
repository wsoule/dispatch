import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { codexPermission } from '../../src/orchestrator/executors/codex.js';
import type { PlanProposal } from '../../src/orchestrator/planner.js';
import {
  CodexPlanner,
  PLANNER_FEATURES,
} from '../../src/orchestrator/planners/codex.js';
import { PLANNER_READ_TOOL_NAMES } from '../../src/orchestrator/planners/codexReadTools.js';
import { EMPTY_TURN_MESSAGE } from '../../src/orchestrator/planners/prompts.js';
import {
  FakeCodexProcess,
  finishTurn,
  scriptedCodex,
  waitFor,
} from './fakeCodex.js';

const PROPOSAL: PlanProposal = {
  tasks: [
    {
      title: 'Do the thing',
      description: 'Do it well.',
      acceptanceCriteria: ['It is done'],
      blockedByIndices: [],
      priority: 'medium',
      writes: ['src/thing.ts'],
      risk: 'routine',
    },
  ],
};

// Each attempt spawns its own App Server; hands the scripted ones out in order.
function plannerOver(
  processes: FakeCodexProcess[],
  rootDir = '/work/shop',
  userServers: string[] = []
): CodexPlanner {
  let next = 0;
  return new CodexPlanner(rootDir, {
    spawnProcess: () => {
      const codex = processes[next];
      next += 1;
      if (codex === undefined)
        throw new Error('no scripted Codex process left');
      return codex;
    },
    userMcpServers: () => userServers,
    env: {},
  });
}

// A turn whose final message is `output` (JSON-encoded unless already text).
function answering(output: unknown): FakeCodexProcess {
  return scriptedCodex({
    onTurn: (c, t) =>
      finishTurn(
        c,
        t,
        typeof output === 'string' ? output : JSON.stringify(output)
      ),
  });
}

function promptOf(codex: FakeCodexProcess): string {
  const input = codex.paramsOf('turn/start')?.input as { text: string }[];
  return input[0].text;
}

describe('CodexPlanner', () => {
  it('returns the reply, proposal and thread id, dropping a null milestone', async () => {
    const codex = answering({
      message: "here's a plan",
      proposal: { milestone: null, ...PROPOSAL },
      questions: [],
    });
    const turn = await plannerOver([codex]).start('build the thing');
    expect(turn).toEqual({
      reply: "here's a plan",
      proposal: PROPOSAL,
      questions: [],
      sessionId: 'thread-1',
    });
  });

  it('plans read-only with no shell, no user MCP servers and the strict schema', async () => {
    const codex = answering({
      message: 'one question first',
      proposal: null,
      questions: [{ id: 'q1', question: 'Which page?', options: ['Home'] }],
    });
    const turn = await plannerOver([codex], '/work/shop', [
      'stripe',
      'posthog',
    ]).start('fix the footer');
    expect(turn.proposal).toBeNull();
    expect(turn.questions).toEqual([
      { id: 'q1', question: 'Which page?', options: ['Home'] },
    ]);

    expect(codex.paramsOf('initialize')?.capabilities).toMatchObject({
      experimentalApi: true,
    });
    const start = codex.paramsOf('thread/start');
    expect(start).toMatchObject({
      cwd: '/work/shop',
      ...codexPermission('plan'),
      config: {
        mcp_servers: {
          stripe: { enabled: false },
          posthog: { enabled: false },
        },
        features: { shell_tool: false, unified_exec: false },
      },
    });
    // Reading the repo goes through Dispatch's confined tools, not a shell.
    const tools = (start?.dynamicTools ?? []) as { name: string }[];
    expect(tools.map((tool) => tool.name)).toEqual([
      ...PLANNER_READ_TOOL_NAMES,
    ]);
    const schema = codex.paramsOf('turn/start')?.outputSchema as {
      required: string[];
      properties: { proposal: { anyOf: { required?: string[] }[] } };
    };
    expect(schema.required).toEqual(['message', 'proposal', 'questions']);
    expect(schema.properties.proposal.anyOf[0].required).toEqual([
      'milestone',
      'tasks',
    ]);
  });

  it('opens with the planning prompt and resumes the thread with the follow-up prompt', async () => {
    const first = answering({
      message: 'v1',
      proposal: PROPOSAL,
      questions: [],
    });
    const second = answering({
      message: 'v2',
      proposal: PROPOSAL,
      questions: [],
    });
    const planner = plannerOver([first, second]);

    const opened = await planner.start('build the thing', 'gpt-5.5');
    const refined = await planner.sendMessage(
      opened.sessionId,
      'make it smaller'
    );

    expect(refined.reply).toBe('v2');
    expect(first.paramsOf('thread/start')?.model).toBe('gpt-5.5');
    // Resume re-sends the sandbox and the shell-off features, so a resumed
    // thread can't pick up a shell or a looser sandbox from the user's config.
    for (const params of [
      first.paramsOf('thread/start'),
      second.paramsOf('thread/resume'),
    ]) {
      expect(params).toMatchObject({
        sandbox: 'read-only',
        approvalPolicy: 'never',
        config: { features: PLANNER_FEATURES },
      });
    }
    expect(second.paramsOf('thread/resume')).toMatchObject({
      threadId: 'thread-1',
    });
    expect(promptOf(first)).toContain(
      'You are planning work for a git-native task tracker'
    );
    expect(promptOf(first)).toContain('build the thing');
    expect(promptOf(second)).toContain('The user is refining the plan');
    expect(promptOf(second)).toContain('make it smaller');
  });

  it('applies config effort.plan to planning turns as Codex effort, not to drafts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-codex-planner-effort-'));
    mkdirSync(join(root, '.dispatch'));
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'effort:\n  plan: max\n'
    );
    try {
      const plan = answering({
        message: 'ok',
        proposal: PROPOSAL,
        questions: [],
      });
      const draft = answering({
        message: 'ok',
        proposal: PROPOSAL,
        questions: [],
      });
      const planner = plannerOver([plan, draft], root);
      await planner.start('plan it');
      await planner.start('rename the button', undefined, 'draft');
      expect(plan.paramsOf('turn/start')?.effort).toBe('xhigh');
      expect(draft.paramsOf('turn/start')?.effort).toBeUndefined();
      expect(promptOf(draft)).toContain(
        'Produce exactly one task (no milestone)'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('shutdown kills an in-flight Codex turn instead of leaving it running', async () => {
    const codex = scriptedCodex();
    const planner = plannerOver([codex]);
    const pending = planner.start('plan it');
    await waitFor(() => codex.paramsOf('turn/start') !== undefined);
    planner.shutdown();
    await expect(pending).rejects.toThrow('stopped');
    expect(codex.killed).toBe(true);
  });

  it('retries once when the final message is not the schema JSON, then gives up plainly', async () => {
    const prose = answering('Sure! Here is the plan in prose.');
    const retry = answering({
      message: 'ok',
      proposal: PROPOSAL,
      questions: [],
    });
    const recovered = await plannerOver([prose, retry]).start('plan it');
    expect(recovered.reply).toBe('ok');
    // The retry is a short correction in the same thread, not the prompt again.
    expect(retry.paramsOf('thread/resume')?.threadId).toBe('thread-1');
    expect(retry.paramsOf('thread/start')).toBeUndefined();
    expect(promptOf(retry)).toBe(
      'Reply with only the JSON object matching the schema.'
    );
    expect(retry.paramsOf('turn/start')?.outputSchema).toBeDefined();

    await expect(
      plannerOver([answering(''), answering('{"message": 3}')]).start('plan it')
    ).rejects.toThrow(EMPTY_TURN_MESSAGE);
  });

  // A turn that asks one approval of `method`, then finishes with a plan.
  function asking(
    method: string,
    params: Record<string, unknown>
  ): FakeCodexProcess {
    return scriptedCodex({
      onTurn: (c, t) => {
        c.serverRequest(method, 'ask-1', {
          threadId: t,
          turnId: 'turn-1',
          ...params,
        });
        setTimeout(
          () =>
            finishTurn(
              c,
              t,
              JSON.stringify({
                message: 'ok',
                proposal: PROPOSAL,
                questions: [],
              })
            ),
          20
        );
      },
    });
  }

  it('declines a command approval', async () => {
    const codex = asking('item/commandExecution/requestApproval', {
      itemId: 'c1',
      startedAtMs: 0,
      environmentId: null,
      command: 'touch x',
      cwd: '/work/shop',
    });
    await plannerOver([codex]).start('plan it');
    expect(codex.responseTo('ask-1')?.result).toEqual({ decision: 'decline' });
  });

  it('declines a file-change approval', async () => {
    const codex = asking('item/fileChange/requestApproval', {
      itemId: 'p1',
      startedAtMs: 0,
      reason: null,
      grantRoot: null,
    });
    await plannerOver([codex]).start('plan it');
    expect(codex.responseTo('ask-1')?.result).toEqual({ decision: 'decline' });
  });

  it('grants no permissions when Codex asks for more', async () => {
    const codex = asking('item/permissions/requestApproval', {
      itemId: 'r1',
      startedAtMs: 0,
      reason: 'write the repo',
      permissions: { fileSystem: { write: ['/work/shop'] } },
    });
    await plannerOver([codex]).start('plan it');
    expect(codex.responseTo('ask-1')?.result).toEqual({
      permissions: {},
      scope: 'turn',
    });
  });

  it('answers a read_file call with the file, and refuses one outside the root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-codex-planner-read-'));
    writeFileSync(join(root, 'notes.md'), 'the footer lives in Footer.tsx\n');
    try {
      const codex = scriptedCodex({
        onTurn: (c, t) => {
          c.serverRequest('item/tool/call', 'call-1', {
            threadId: t,
            turnId: 'turn-1',
            callId: 'c1',
            namespace: null,
            tool: 'read_file',
            arguments: { path: 'notes.md' },
          });
          c.serverRequest('item/tool/call', 'call-2', {
            threadId: t,
            turnId: 'turn-1',
            callId: 'c2',
            namespace: null,
            tool: 'read_file',
            arguments: { path: '../../etc/hosts' },
          });
          void waitFor(
            () =>
              c.responseTo('call-1') !== undefined &&
              c.responseTo('call-2') !== undefined
          ).then(() =>
            finishTurn(
              c,
              t,
              JSON.stringify({
                message: 'ok',
                proposal: PROPOSAL,
                questions: [],
              })
            )
          );
        },
      });
      const turn = await plannerOver([codex], root).start('fix the footer');
      expect(turn.reply).toBe('ok');
      expect(codex.responseTo('call-1')?.result).toEqual({
        contentItems: [
          { type: 'inputText', text: '1\tthe footer lives in Footer.tsx' },
        ],
        success: true,
      });
      expect(codex.responseTo('call-2')?.result).toMatchObject({
        success: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
