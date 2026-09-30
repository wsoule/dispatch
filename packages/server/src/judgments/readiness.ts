import type { TaskDoc } from '@dispatch/core';
import { noul, score } from '@typesafe-ai/sdk';
import type { EntryType, NoulResponse, ScoreResponse } from '@typesafe-ai/sdk';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { JudgmentClient } from './client.js';
import { capText, mapLimit, warnOnce } from './client.js';

/**
 * How completely a task says what "done" looks like, judged from its title,
 * body and declared writes. Feeds the queue's `readiness` factor and the
 * board's spec badge; never hides a task — a low level only demotes it.
 *
 * Readings are cached by content hash in `.dispatch/readiness.json`, so a
 * board refresh costs nothing until a task's text changes.
 */

export interface ReadinessReading {
  /** Index into READINESS_LEVELS — the most probable rubric level. */
  level: 0 | 1 | 2 | 3;
  label: string;
  confidence: number;
  /** Probability the task bundles two or more independently doable changes. */
  splitProbability: number;
}

/** The rubric, lowest first. Each level is a concrete situation so the
 *  model has no interpolating to do. */
export const READINESS_LEVELS = [
  'Only a title; nothing says what done looks like',
  'Describes the change, but names neither acceptance criteria nor the files or surface it lands in',
  'Names the files or surface it lands in, OR gives acceptance criteria, but not both',
  'Gives acceptance criteria AND names where the change lands',
] as const;

/** Body sent as state; a task with more than this is not the problem this
 *  reading exists to catch, and the tail would only distract. */
const BODY_CAP = 12_000;
const CONCURRENCY = 4;

export function readinessQuestions() {
  return {
    readiness: score(
      'How completely does this task spec say what a finished change looks like? Judge `body` together with `title` and `declaredWrites`.',
      READINESS_LEVELS
    ),
    split: noul(
      'Does this task ask for two or more changes that could each be done and verified on their own?',
      {
        true: 'the body lists separate changes with no shared step, such as two unrelated fixes or a feature plus an unrelated refactor',
        false: 'one change, or several steps that only make sense together',
      }
    ),
  };
}

export function readinessState(task: TaskDoc): EntryType {
  return {
    title: task.meta.title,
    body: capText(task.body, BODY_CAP),
    declaredWrites: [...task.meta.writes],
  };
}

type ReadinessAnswers = {
  readiness: ScoreResponse;
  split: NoulResponse;
};

export function interpretReadiness(
  answers: ReadinessAnswers
): ReadinessReading {
  // Argmax over the rubric rather than rounding the expected score: Jev's
  // score expectation is not numerically calibrated between levels.
  let level: ReadinessReading['level'] = 0;
  let best = -1;
  const probabilities = answers.readiness.probabilities as Record<
    string,
    number
  >;
  for (const index of [0, 1, 2, 3] as const) {
    const p = probabilities[String(index)] ?? 0;
    if (p > best) {
      best = p;
      level = index;
    }
  }
  return {
    level,
    label: READINESS_LEVELS[level],
    confidence: answers.readiness.confidence,
    splitProbability: answers.split.noul,
  };
}

/** Title, body and writes together: any edit to what the model saw
 *  invalidates the reading. */
export function readinessHash(task: TaskDoc): string {
  return createHash('sha256')
    .update(task.meta.title)
    .update('\0')
    .update(task.body)
    .update('\0')
    .update(task.meta.writes.join('\n'))
    .digest('hex')
    .slice(0, 16);
}

type ReadinessCache = Record<
  string,
  { hash: string; reading: ReadinessReading }
>;

/** `.dispatch/readiness.json` — readings keyed by task id with the hash
 *  they were judged against. A corrupt file reads as empty. */
export class ReadinessStore {
  private readonly file: string;

  constructor(rootDir: string) {
    this.file = join(rootDir, '.dispatch', 'readiness.json');
  }

  load(): ReadinessCache {
    if (!existsSync(this.file)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      )
        return {};
      return parsed as ReadinessCache;
    } catch {
      return {};
    }
  }

  save(cache: ReadinessCache): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(cache, null, 2)}\n`);
  }

  /** The cached readings still judged against their task's current text:
   *  what `readinessFor` returns for them without judging. `taskOf` is null
   *  for a task that is gone. */
  loadFresh(
    taskOf: (id: string) => TaskDoc | null
  ): Record<string, ReadinessReading> {
    const readings: Record<string, ReadinessReading> = {};
    for (const [id, entry] of Object.entries(this.load())) {
      const task = taskOf(id);
      if (task !== null && readinessHash(task) === entry.hash) {
        readings[id] = entry.reading;
      }
    }
    return readings;
  }
}

/**
 * The readings for `tasks`: cached ones whose hash still matches, plus fresh
 * judgments for the rest, persisted before returning. On a failed request
 * the cached readings still come back — a dead API degrades to "some tasks
 * unjudged", never to an error on the ready route.
 */
export async function readinessFor(
  client: JudgmentClient | null,
  tasks: TaskDoc[],
  store: ReadinessStore
): Promise<Record<string, ReadinessReading>> {
  if (client === null) return {};
  const cache = store.load();
  const readings: Record<string, ReadinessReading> = {};
  const stale: TaskDoc[] = [];
  for (const task of tasks) {
    const hash = readinessHash(task);
    const cached = cache[task.meta.id];
    if (cached !== undefined && cached.hash === hash)
      readings[task.meta.id] = cached.reading;
    else stale.push(task);
  }
  if (stale.length === 0) return readings;
  try {
    const judged = await mapLimit(stale, CONCURRENCY, async (task) => {
      const { answers } = await client.judge(
        readinessState(task),
        readinessQuestions()
      );
      return {
        id: task.meta.id,
        hash: readinessHash(task),
        reading: interpretReadiness(answers),
      };
    });
    for (const { id, hash, reading } of judged) {
      readings[id] = reading;
      cache[id] = { hash, reading };
    }
    store.save(cache);
  } catch (err) {
    warnOnce('readiness', err);
  }
  return readings;
}
