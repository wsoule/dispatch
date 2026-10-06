import type { ModelConfig, TaskDoc, TaskRisk } from '@dispatch-foo/core';
import { choice } from '@typesafe-ai/sdk';
import type { ChoiceResponse, EntryType } from '@typesafe-ai/sdk';

import type { JudgmentClient } from './client.js';
import { capText, warnOnce } from './client.js';

/**
 * Which model tier a fresh run should get, judged from the task. Only ever
 * lowers the tier: routine work that reads as trivial or small runs on the
 * planning model instead of the coding model. A model the caller named, or
 * a task's own `model` override, is never touched (see dispatchOrResume).
 */

type Complexity = 'trivial' | 'small' | 'substantial';

/** The two tiers a judged run can land on; both must be known to judge at all. */
export type ExecuteTierModels = Pick<ModelConfig, 'execute' | 'plan'>;

export interface RunModelChoice {
  /** Undefined when the executor runs on its own default model. */
  model: string | undefined;
  /** Why the tier was lowered, for the task's Activity log; null when the
   *  configured coding model stands. */
  reason: string | null;
}

/** Below this the Choice is not trusted to lower the tier. */
const CONFIDENCE_FLOOR = 0.7;
const BODY_CAP = 12_000;

const COMPLEXITY_CRITERIA: Record<Complexity, string> = {
  trivial:
    'a one-file, mechanical change: a rename, a typo, a config value, copy text',
  small:
    'a contained change in one area with clear steps and no design decisions to make',
  substantial:
    'cross-cutting, needs design decisions, or touches several subsystems',
};

export function modelTierQuestions() {
  return {
    complexity: choice(
      'How much work is this task, judged from `title`, `body` and `writes`? Pick the level whose description fits the change actually asked for.',
      { ...COMPLEXITY_CRITERIA }
    ),
  };
}

export function modelTierState(task: TaskDoc): EntryType {
  return {
    title: task.meta.title,
    body: capText(task.body, BODY_CAP),
    writes: [...task.meta.writes],
    risk: task.meta.risk,
  };
}

/** The rule, in code: routine risk, a trivial or small reading, and enough
 *  confidence → the planning tier; anything else → the coding tier. */
export function chooseRunModel(
  risk: TaskRisk,
  answer: Pick<ChoiceResponse, 'choice' | 'confidence'> | null,
  models: ExecuteTierModels
): RunModelChoice {
  if (
    answer === null ||
    risk !== 'routine' ||
    answer.confidence < CONFIDENCE_FLOOR ||
    (answer.choice !== 'trivial' && answer.choice !== 'small')
  ) {
    return { model: models.execute, reason: null };
  }
  return {
    model: models.plan,
    reason: `judged ${answer.choice} (${answer.confidence.toFixed(2)}) on ${risk} risk`,
  };
}

/** The model a fresh run of `task` should use. Falls back to the coding
 *  tier without a client, when the task carries its own override, or when
 *  the request fails — so an unconfigured daemon dispatches as before. */
export async function judgeRunModel(
  client: JudgmentClient | null,
  task: TaskDoc,
  models: ExecuteTierModels
): Promise<RunModelChoice> {
  if (client === null || task.meta.model !== null) {
    return { model: models.execute, reason: null };
  }
  try {
    const { answers } = await client.judge(
      modelTierState(task),
      modelTierQuestions()
    );
    return chooseRunModel(task.meta.risk, answers.complexity, models);
  } catch (err) {
    warnOnce('model tier', err);
    return { model: models.execute, reason: null };
  }
}
