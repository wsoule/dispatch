import { randomBytes } from 'node:crypto';

import {
  OrchestratorConflictError,
  OrchestratorNotFoundError,
} from './types.js';

/** One question an agent raised mid-run, and the human's answer once it lands. */
export interface RunQuestion {
  id: string;
  runId: string;
  question: string;
  /** Suggested answers the UI renders as one-click chips. Free text always allowed. */
  options: string[];
  askedAt: string;
  answer: string | null;
  answeredAt: string | null;
}

/**
 * How long one long-poll parks before returning the still-unanswered record.
 * Deliberately well under the 65s socket budget `/api/` requests get in
 * index.ts — the asking tool re-polls, so a short window costs nothing.
 */
export const QUESTION_POLL_MS = 30_000;

type Waiter = (question: RunQuestion) => void;

/**
 * The pending-questions registry behind the blocking `ask_user` MCP tool: an
 * agent posts a question, its tool call parks on `waitForAnswer`, and the
 * human's answer resolves it. In-memory only — a question has no meaning past
 * the lifetime of the daemon holding the run that asked it.
 */
export class QuestionRegistry {
  private readonly questions = new Map<string, RunQuestion>();
  private readonly waiters = new Map<string, Set<Waiter>>();

  private mintId(): string {
    let id = `q-${randomBytes(3).toString('hex')}`;
    while (this.questions.has(id)) id = `q-${randomBytes(3).toString('hex')}`;
    return id;
  }

  ask(runId: string, question: string, options: string[] = []): RunQuestion {
    const record: RunQuestion = {
      id: this.mintId(),
      runId,
      question,
      options,
      askedAt: new Date().toISOString(),
      answer: null,
      answeredAt: null,
    };
    this.questions.set(record.id, record);
    return record;
  }

  get(id: string): RunQuestion | undefined {
    return this.questions.get(id);
  }

  /** Every unanswered question, oldest first — all runs, or just `runId`'s. */
  listOpen(runId?: string): RunQuestion[] {
    return [...this.questions.values()].filter(
      (q) => q.answer === null && (runId === undefined || q.runId === runId)
    );
  }

  answer(id: string, text: string): RunQuestion {
    const record = this.questions.get(id);
    if (record === undefined) {
      throw new OrchestratorNotFoundError(`question not found: ${id}`);
    }
    if (record.answer !== null) {
      throw new OrchestratorConflictError(`question already answered: ${id}`);
    }
    record.answer = text;
    record.answeredAt = new Date().toISOString();
    this.release(record);
    return record;
  }

  /**
   * Resolves with the question once answered, or with the still-unanswered
   * record after `timeoutMs`. A timeout is an ordinary outcome, not an error:
   * the caller is expected to poll again.
   */
  waitForAnswer(id: string, timeoutMs: number): Promise<RunQuestion> {
    const record = this.questions.get(id);
    if (record === undefined) {
      return Promise.reject(
        new OrchestratorNotFoundError(`question not found: ${id}`)
      );
    }
    if (record.answer !== null) return Promise.resolve(record);

    return new Promise<RunQuestion>((resolve) => {
      const waiter: Waiter = (answered) => {
        clearTimeout(timer);
        resolve(answered);
      };
      const timer = setTimeout(() => {
        this.waiters.get(id)?.delete(waiter);
        resolve(this.questions.get(id) ?? record);
      }, timeoutMs);
      const set = this.waiters.get(id) ?? new Set<Waiter>();
      set.add(waiter);
      this.waiters.set(id, set);
    });
  }

  /**
   * Drops every question a run owns and wakes anything still parked on one.
   * Wired to the orchestrator's terminal hook so a cancelled or finished run
   * never leaves a stale "waiting on you" question behind.
   */
  closeRun(runId: string): void {
    for (const record of [...this.questions.values()]) {
      if (record.runId !== runId) continue;
      this.questions.delete(record.id);
      this.release(record);
    }
  }

  private release(record: RunQuestion): void {
    const set = this.waiters.get(record.id);
    if (set === undefined) return;
    this.waiters.delete(record.id);
    for (const waiter of set) waiter(record);
  }
}
