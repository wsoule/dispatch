import { generateFindingId } from '@dispatch/core';
import type {
  Finding,
  FindingRecommendation,
  FindingSeverity,
  FindingVerdict,
} from '@dispatch/core';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Review findings raised against a task, one JSON line per write in
// `.dispatch/findings.jsonl`. An update is a fresh line, not a rewrite.

export interface AddFindingInput {
  taskId: string;
  runId: string | null;
  severity: FindingSeverity;
  title: string;
  detail: string;
  file?: string | null;
  line?: number | null;
  round?: number;
  recommendation?: FindingRecommendation;
}

export interface FindingUpdatePatch {
  verdict?: FindingVerdict;
  ruling?: string | null;
}

export interface FindingListFilter {
  taskId?: string;
  verdict?: FindingVerdict;
  severity?: FindingSeverity;
}

export class FindingStore {
  private readonly file: string;

  constructor(rootDir: string) {
    this.file = join(rootDir, '.dispatch', 'findings.jsonl');
  }

  // Compacts the append-only file into current state: last line written
  // for a given id wins, in that id's first-seen order.
  private read(): Finding[] {
    if (!existsSync(this.file)) return [];
    const byId = new Map<string, Finding>();
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const record = JSON.parse(line) as Finding;
        byId.set(record.id, record);
      } catch {
        // A hand-corrupted line costs itself, not the rest of the store.
      }
    }
    return [...byId.values()];
  }

  private append(record: Finding): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(record)}\n`);
  }

  get(id: string): Finding | null {
    return this.read().find((f) => f.id === id) ?? null;
  }

  list(filter: FindingListFilter = {}): Finding[] {
    return this.read().filter(
      (f) =>
        (filter.taskId === undefined || f.taskId === filter.taskId) &&
        (filter.verdict === undefined || f.verdict === filter.verdict) &&
        (filter.severity === undefined || f.severity === filter.severity)
    );
  }

  // The findings still blocking a task's fix loop.
  openFor(taskId: string): Finding[] {
    return this.list({ taskId, verdict: 'open' });
  }

  add(input: AddFindingInput): Finding {
    const now = new Date().toISOString();
    const record: Finding = {
      id: generateFindingId(now),
      taskId: input.taskId,
      runId: input.runId,
      severity: input.severity,
      verdict: 'open',
      title: input.title,
      detail: input.detail,
      file: input.file ?? null,
      line: input.line ?? null,
      ruling: null,
      round: input.round ?? 0,
      createdAt: now,
      updatedAt: now,
      // Spread rather than set, so a finding raised without one keeps exactly
      // the shape it had before reviewers were asked for a recommendation.
      ...(input.recommendation !== undefined
        ? { recommendation: input.recommendation }
        : {}),
    };
    this.append(record);
    return record;
  }

  update(id: string, patch: FindingUpdatePatch): Finding {
    const existing = this.get(id);
    if (existing === null) throw new Error(`finding not found: ${id}`);
    const updated: Finding = {
      ...existing,
      verdict: patch.verdict ?? existing.verdict,
      ruling: patch.ruling !== undefined ? patch.ruling : existing.ruling,
      updatedAt: new Date().toISOString(),
    };
    this.append(updated);
    return updated;
  }
}
