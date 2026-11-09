import type {
  DifficultyJudgment,
  DifficultyLevel,
  DifficultyPolicy,
  TaskDoc,
} from '@dispatch-foo/core';
import { DIFFICULTY_LEVELS, removeSection } from '@dispatch-foo/core';

import type { JudgmentClient } from './client.js';
import { warnOnce } from './client.js';
import { modelTierQuestions, modelTierState } from './modelTier.js';

/**
 * The difficulty evaluator: how hard a task is, for the difficulty lift
 * (core/policy.ts difficultyEligibility). The rubric IS the judged model
 * tier's — the same Jev Choice over `title`, `body`, `writes` and `risk`
 * (modelTier.ts COMPLEXITY_CRITERIA) — so one definition of "easy" decides
 * both which model a task runs on and whether it lands unattended.
 *
 * The task's Activity log is cut from the judged body: it grows with every
 * run and receipt, and neither changes how much work the task asks for. That
 * also keeps the cache below from re-judging a task each time the daemon
 * narrates it.
 */
export class DifficultyEvaluator {
  // Per task: the judged input and the request for it. Keyed by the input
  // itself, so an edit to the title, body, writes or risk re-judges and
  // anything else does not. A failed request is dropped, not cached.
  private readonly cache = new Map<
    string,
    { key: string; judgment: Promise<DifficultyJudgment | null> }
  >();

  constructor(private readonly client: JudgmentClient | null) {}

  /** Null without a client, or when the request failed: every caller reads
   *  null as "not eligible", so an unconfigured daemon never lifts a gate. */
  judge(task: TaskDoc): Promise<DifficultyJudgment | null> {
    const client = this.client;
    if (client === null) return Promise.resolve(null);
    const state = modelTierState({
      ...task,
      body: removeSection(task.body, 'Activity'),
    });
    const key = JSON.stringify(state);
    const cached = this.cache.get(task.meta.id);
    if (cached?.key === key) return cached.judgment;
    const judgment = client
      .judge(state, modelTierQuestions())
      .then(({ answers }) => {
        const answer = answers.complexity;
        if (!DIFFICULTY_LEVELS.includes(answer.choice as DifficultyLevel)) {
          return null;
        }
        return {
          level: answer.choice as DifficultyLevel,
          confidence: answer.confidence,
        };
      })
      .catch((err: unknown) => {
        warnOnce('difficulty', err);
        if (this.cache.get(task.meta.id)?.key === key) {
          this.cache.delete(task.meta.id);
        }
        return null;
      });
    this.cache.set(task.meta.id, { key, judgment });
    return judgment;
  }
}

/**
 * What the safety gate measures in a unified diff: added plus removed lines,
 * counted only inside hunks — a removed line whose own text starts `-- `
 * renders as `--- …` and must not pass for a file header — and whether any
 * file is binary, whose change no line count can describe.
 */
export function measurePatch(patch: string): {
  lines: number;
  binary: boolean;
} {
  let lines = 0;
  let binary = false;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
    } else if (line.startsWith('@@')) {
      inHunk = true;
    } else if (inHunk) {
      if (line.startsWith('+') || line.startsWith('-')) lines++;
    } else if (
      line.startsWith('Binary files ') ||
      line.startsWith('GIT binary patch')
    ) {
      binary = true;
    }
  }
  return { lines, binary };
}

export type SafetyGateResult =
  | { ok: true; summary: string }
  | { ok: false; reason: string };

/**
 * The difficulty lift's safety gate in front of the merge queue: the judged
 * difficulty only says the task SHOULD be small, so the actual change must be
 * small too, and something must prove it green. "Green" is a verification of
 * the change as it stands passing, or — without one — a merge-time check the
 * queue runs on the landing head (`verifyCommand`/`verifySteps`). A red
 * verification always holds, and with neither there is nothing to say the
 * change works, so a human looks. The caller passes `verification` only when
 * it postdates every commit to the branch (PolicyEngine.freshVerification):
 * a green result for older code proves nothing. The queue's own gates
 * (rebase, verify, GitHub CI holds) still run after this one.
 */
export function autoLandSafetyGate(
  difficulty: Pick<DifficultyPolicy, 'maxFiles' | 'maxLines'>,
  diff: { files: readonly unknown[]; patch: string },
  verification: { pass: boolean; runId: string } | null,
  hasMergeCheck: boolean
): SafetyGateResult {
  const files = diff.files.length;
  const { lines, binary } = measurePatch(diff.patch);
  if (binary) {
    return { ok: false, reason: 'its diff changes a binary file' };
  }
  if (files > difficulty.maxFiles) {
    return {
      ok: false,
      reason: `its diff touches ${files} files, over the ${difficulty.maxFiles}-file ceiling`,
    };
  }
  if (lines > difficulty.maxLines) {
    return {
      ok: false,
      reason: `its diff changes ${lines} lines, over the ${difficulty.maxLines}-line ceiling`,
    };
  }
  let green: string;
  if (verification !== null) {
    if (!verification.pass) {
      return {
        ok: false,
        reason: `its latest verification (${verification.runId}) is red`,
      };
    }
    green = `verification ${verification.runId} green`;
  } else if (hasMergeCheck) {
    green = 'the merge-time verify check must pass before it lands';
  } else {
    return {
      ok: false,
      reason:
        'nothing proves it green: the task never verified and the project configures no verifyCommand or verifySteps',
    };
  }
  return {
    ok: true,
    summary: `${files} files / ${lines} lines within ${difficulty.maxFiles}/${difficulty.maxLines}; ${green}`,
  };
}
