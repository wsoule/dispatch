import type { TaskDoc } from '@dispatch-foo/core';
import { getSection } from '@dispatch-foo/core';
import { noul } from '@typesafe-ai/sdk';
import type { EntryType, NoulQuestion, NoulResponse } from '@typesafe-ai/sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { checklistPath } from '../orchestrator/paths.js';
import type { RunMeta } from '../orchestrator/types.js';
import type { DiffResult } from '../orchestrator/worktree.js';
import type { JudgmentClient } from './client.js';
import { capText, warnOnce } from './client.js';

/**
 * A finished run's diff checked against what its task asked for: one yes/no
 * per requirement, plus whether the diff strays beyond them. Requirements
 * come from the task body in code — Jev selects and judges, it does not
 * write — and the result annotates the landing row; it never blocks a merge.
 */

interface ChecklistItem {
  text: string;
  /** Probability the diff implements this requirement. */
  probability: number;
}

export interface RunChecklist {
  runId: string;
  taskId: string;
  items: ChecklistItem[];
  /** Items at or above PASS. */
  passed: number;
  total: number;
  /** Texts of items below WEAK — the ones worth a human look. */
  weak: string[];
  /** Probability the diff changes behaviour no requirement asks for. */
  scopeCreep: number;
  createdAt: string;
}

export interface ChecklistSummary {
  passed: number;
  total: number;
  weak: string[];
}

const PASS = 0.7;
const WEAK = 0.5;
/** More than this and the task is really an epic; the tail would be noise. */
const MAX_REQUIREMENTS = 12;
/** Diff text sent as state, inside Jev's 32k-token state budget. */
const PATCH_CAP = 60_000;

const CHECKBOX = /^\s*[-*]\s+\[[ xX]\]\s+(.+?)\s*$/;
const BULLET = /^\s*[-*]\s+(.+?)\s*$/;

// The captured text of every line matching `pattern`.
function lines(text: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = pattern.exec(line);
    if (m !== null) out.push(m[1]);
  }
  return out;
}

/**
 * The checkable statements a task makes, most deliberate form first:
 * checkbox lines anywhere, else the Acceptance Criteria section's bullets,
 * else every bullet in the body, else the title itself. The bullet tiers
 * only run when no checkbox line exists, so they never re-read one.
 */
export function extractRequirements(body: string, title: string): string[] {
  const checkboxes = lines(body, CHECKBOX);
  if (checkboxes.length > 0) return checkboxes.slice(0, MAX_REQUIREMENTS);
  const criteria = lines(getSection(body, 'Acceptance Criteria'), BULLET);
  if (criteria.length > 0) return criteria.slice(0, MAX_REQUIREMENTS);
  const bullets = lines(body, BULLET);
  if (bullets.length > 0) return bullets.slice(0, MAX_REQUIREMENTS);
  return [title];
}

type ChecklistQuestions = Record<`req_${number}`, NoulQuestion> & {
  scope_creep: NoulQuestion;
};

export function checklistQuestions(requirements: string[]): ChecklistQuestions {
  const questions = {} as ChecklistQuestions;
  requirements.forEach((requirement, i) => {
    questions[`req_${i}`] = noul(
      {
        requirement,
        question: 'Does `diff.patch` implement `requirement`?',
      },
      {
        true: 'the diff contains the change the requirement asks for',
        false: 'the diff does not make this change, or makes only part of it',
      }
    );
  });
  questions.scope_creep = noul(
    'Does `diff.patch` change behaviour that none of `task.requirements` asks for?',
    {
      true: 'the diff adds, removes or alters behaviour outside every listed requirement',
      false:
        'every change in the diff serves a listed requirement, allowing for tests and small refactors those changes need',
    }
  );
  return questions;
}

export function checklistState(
  task: TaskDoc,
  requirements: string[],
  diff: DiffResult
): EntryType {
  return {
    task: { title: task.meta.title, requirements: [...requirements] },
    diff: {
      files: diff.files.map((f) => f.path),
      patch: capText(diff.patch, PATCH_CAP),
    },
  };
}

type ChecklistAnswers = Record<string, NoulResponse | undefined>;

export function interpretChecklist(
  runId: string,
  taskId: string,
  requirements: string[],
  answers: ChecklistAnswers,
  now: string
): RunChecklist {
  const items = requirements.map((text, i) => ({
    text,
    probability: answers[`req_${i}`]?.noul ?? 0,
  }));
  return {
    runId,
    taskId,
    items,
    passed: items.filter((i) => i.probability >= PASS).length,
    total: items.length,
    weak: items.filter((i) => i.probability < WEAK).map((i) => i.text),
    scopeCreep: answers.scope_creep?.noul ?? 0,
    createdAt: now,
  };
}

/** The three numbers a landing row shows. */
export function checklistSummary(checklist: RunChecklist): ChecklistSummary {
  return {
    passed: checklist.passed,
    total: checklist.total,
    weak: [...checklist.weak],
  };
}

/**
 * Judges `diff` against `task` and writes the result under the run dir.
 * Null when there is no client or the request failed — the landing row
 * simply shows no checklist, as it did before.
 */
export async function computeChecklist(
  client: JudgmentClient | null,
  rootDir: string,
  meta: RunMeta,
  task: TaskDoc,
  diff: DiffResult
): Promise<RunChecklist | null> {
  if (client === null) return null;
  const requirements = extractRequirements(task.body, task.meta.title);
  try {
    const { answers } = await client.judge(
      checklistState(task, requirements, diff),
      checklistQuestions(requirements)
    );
    const checklist = interpretChecklist(
      meta.id,
      meta.taskId,
      requirements,
      answers as ChecklistAnswers,
      new Date().toISOString()
    );
    const path = checklistPath(rootDir, meta.id);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(checklist, null, 2)}\n`);
    return checklist;
  } catch (err) {
    warnOnce('landing checklist', err);
    return null;
  }
}

/** The stored checklist for a run, or null when none was written (or the
 *  file is unreadable — a corrupt cache costs itself, not the page). */
export function readChecklist(
  rootDir: string,
  runId: string
): RunChecklist | null {
  const path = checklistPath(rootDir, runId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RunChecklist;
  } catch {
    return null;
  }
}
