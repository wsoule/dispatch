import type { TaskDoc } from '@dispatch-foo/core';
import { defaultTaskFields } from '@dispatch-foo/core';
import { describe, expect, spyOn, test } from 'bun:test';

import type { JudgmentClient } from '../../src/judgments/client';
import {
  autoLandSafetyGate,
  DifficultyEvaluator,
  measurePatch,
} from '../../src/judgments/difficulty';

function task(body = 'Fix the typo.\n', title = 'Fix a typo'): TaskDoc {
  return {
    meta: {
      id: 't-000001',
      title,
      status: 'ready',
      kind: 'task',
      parent: null,
      milestone: null,
      blockedBy: [],
      labels: [],
      priority: 'medium',
      assignee: 'none',
      risk: 'routine',
      model: null,
      selfReview: true,
      writes: ['README.md'],
      external: null,
      exercised: false,
      ...defaultTaskFields(),
      created: '2026-09-01T00:00:00.000Z',
      updated: '2026-09-01T00:00:00.000Z',
    },
    body,
  };
}

// A client answering `choice` and recording every state it was sent.
function stub(
  choice: string,
  confidence = 0.9
): JudgmentClient & { states: unknown[] } {
  const states: unknown[] = [];
  return {
    model: 'jev-test',
    states,
    judge: (state) => {
      states.push(state);
      return Promise.resolve({
        model: 'jev-test',
        answers: {
          complexity: { type: 'choice', choice, confidence, probabilities: {} },
        },
        usage: { input_tokens: 1, output_tokens: 0 },
      } as never);
    },
  };
}

describe('DifficultyEvaluator', () => {
  test('judges with the model tier rubric over a body without its Activity log', async () => {
    const client = stub('trivial', 0.93);
    const evaluator = new DifficultyEvaluator(client);
    const judgment = await evaluator.judge(
      task('Fix the typo.\n\n## Activity\n- dispatched\n')
    );
    expect(judgment).toEqual({ level: 'trivial', confidence: 0.93 });
    expect(client.states).toHaveLength(1);
    expect(JSON.stringify(client.states[0])).not.toContain('dispatched');
  });

  test('re-judges an edited task but not one whose Activity merely grew', async () => {
    const client = stub('small');
    const evaluator = new DifficultyEvaluator(client);
    await evaluator.judge(task('Fix it.\n\n## Activity\n- one\n'));
    await evaluator.judge(task('Fix it.\n\n## Activity\n- one\n- two\n'));
    expect(client.states).toHaveLength(1);
    await evaluator.judge(task('Fix it, and the other one.\n'));
    expect(client.states).toHaveLength(2);
  });

  test('answers null without a client, and on a failed request — which is not cached', async () => {
    expect(await new DifficultyEvaluator(null).judge(task())).toBeNull();
    let calls = 0;
    const failing: JudgmentClient = {
      model: 'jev-test',
      judge: () => {
        calls++;
        return Promise.reject(new Error('offline'));
      },
    };
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const evaluator = new DifficultyEvaluator(failing);
    expect(await evaluator.judge(task())).toBeNull();
    expect(await evaluator.judge(task())).toBeNull();
    expect(calls).toBe(2);
    warn.mockRestore();
  });

  test('reads an answer outside the rubric as no judgment', async () => {
    expect(
      await new DifficultyEvaluator(stub('enormous')).judge(task())
    ).toBeNull();
  });
});

describe('autoLandSafetyGate', () => {
  const ceilings = { maxFiles: 2, maxLines: 4 };
  const patch = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n';

  test('counts added and removed lines inside hunks, not file headers', () => {
    const full = `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n`;
    expect(measurePatch(full)).toEqual({ lines: 2, binary: false });
    expect(measurePatch('')).toEqual({ lines: 0, binary: false });
  });

  test('counts a hunk line that looks like a file header', () => {
    // Removing `-- x` and adding `++ y` render as `--- x` and `+++ y`.
    const sneaky = `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n--- x\n+++ y\n`;
    expect(measurePatch(sneaky).lines).toBe(2);
  });

  test('flags a binary file, and holds the diff for it', () => {
    const bin =
      'diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n';
    expect(measurePatch(bin)).toEqual({ lines: 0, binary: true });
    expect(
      autoLandSafetyGate(ceilings, { files: ['i.png'], patch: bin }, null, true)
    ).toEqual({ ok: false, reason: 'its diff changes a binary file' });
  });

  test('passes a small diff with a green verification, naming both', () => {
    expect(
      autoLandSafetyGate(
        ceilings,
        { files: ['x'], patch },
        { pass: true, runId: 'r-v' },
        false
      )
    ).toEqual({
      ok: true,
      summary: '1 files / 2 lines within 2/4; verification r-v green',
    });
  });

  test('passes an unverified diff when the merge queue runs a check of its own', () => {
    const gate = autoLandSafetyGate(
      ceilings,
      { files: ['x'], patch },
      null,
      true
    );
    expect(gate.ok).toBe(true);
  });

  test('holds a wide diff, a long diff, a red verification, and an unprovable one', () => {
    const reasons = [
      autoLandSafetyGate(
        ceilings,
        { files: ['a', 'b', 'c'], patch },
        null,
        true
      ),
      autoLandSafetyGate(
        ceilings,
        { files: ['x'], patch: '@@ -0,0 +1,5 @@\n+1\n+2\n+3\n+4\n+5\n' },
        null,
        true
      ),
      autoLandSafetyGate(
        ceilings,
        { files: ['x'], patch },
        { pass: false, runId: 'r-v' },
        true
      ),
      autoLandSafetyGate(ceilings, { files: ['x'], patch }, null, false),
    ].map((g) => (g.ok ? 'ok' : g.reason));
    expect(reasons).toEqual([
      'its diff touches 3 files, over the 2-file ceiling',
      'its diff changes 5 lines, over the 4-line ceiling',
      'its latest verification (r-v) is red',
      'nothing proves it green: the task never verified and the project configures no verifyCommand or verifySteps',
    ]);
  });
});
