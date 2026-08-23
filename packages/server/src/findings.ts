import { generateFindingId } from '@dispatch/core';
import type {
  AddFindingInput,
  Finding,
  FindingListFilter,
  FindingUpdatePatch,
} from '@dispatch/core';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Review findings raised against a task, one JSON line per write in
// `.dispatch/findings.jsonl`. An update is a fresh line, not a rewrite.

// Re-exported, not re-declared: `@dispatch/core` owns these shapes (they sit
// beside the `Finding` they produce, so the database-backed store can take
// the same inputs), and a second copy here is one that can drift from the
// backend on the other side of the port below.
export type {
  AddFindingInput,
  FindingListFilter,
  FindingUpdatePatch,
} from '@dispatch/core';

/**
 * The findings surface every backend answers, so the daemon can hold either
 * the JSONL store below or core's `SqliteFindingStore` without any handler
 * knowing which. Structural, not `implements`: `SqliteFindingStore` lives in
 * `@dispatch/core` and cannot import this file, and its extra optional `now`
 * parameters are compatible with these signatures anyway.
 */
export interface FindingStorePort {
  get(id: string): Finding | null;
  list(filter?: FindingListFilter): Finding[];
  openFor(taskId: string): Finding[];
  add(input: AddFindingInput): Finding;
  update(id: string, patch: FindingUpdatePatch): Finding;
}

// How many times add() will re-roll an id before giving up. Far beyond what
// randomness needs; it only bounds a generator that keeps returning a taken id.
const MINT_ATTEMPTS = 32;

// The fields every read path dereferences. A hand-edited line missing one is
// not a finding: without an id, update() writes past it and never edits it.
function isFinding(value: unknown): value is Finding {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    record.id !== '' &&
    typeof record.taskId === 'string' &&
    typeof record.severity === 'string' &&
    typeof record.verdict === 'string' &&
    typeof record.title === 'string' &&
    typeof record.detail === 'string' &&
    typeof record.createdAt === 'string'
  );
}

export class FindingStore implements FindingStorePort {
  private readonly file: string;
  private readonly generateId: (now: string) => string;
  // Ids already reported as colliding, so a damaged file logs once, not on
  // every read.
  private readonly reportedCollisions = new Set<string>();
  // Same idea for lines that parse but are not findings, keyed by the line
  // itself.
  private readonly reportedInvalidLines = new Set<string>();

  constructor(
    rootDir: string,
    generateId: (now: string) => string = generateFindingId
  ) {
    this.file = join(rootDir, '.dispatch', 'findings.jsonl');
    this.generateId = generateId;
  }

  // Compacts the append-only file, keyed by id + createdAt because update()
  // re-appends both — so two records that minted one id both survive.
  private read(): Finding[] {
    if (!existsSync(this.file)) return [];
    const byRecord = new Map<string, Finding>();
    const firstKeyForId = new Map<string, string>();
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isFinding(parsed)) {
          this.reportInvalidLine(line);
          continue;
        }
        // Older lines pre-date raisedBy; default it so they stay loadable.
        const record: Finding = { ...parsed, raisedBy: parsed.raisedBy ?? '' };
        const key = `${record.id}\n${record.createdAt}`;
        const first = firstKeyForId.get(record.id);
        if (first === undefined) firstKeyForId.set(record.id, key);
        else if (first !== key) this.reportCollision(record.id);
        byRecord.set(key, record);
      } catch {
        // A hand-corrupted line costs itself, not the rest of the store.
      }
    }
    return [...byRecord.values()];
  }

  // A repeated id with a different createdAt is two findings, not an edit —
  // both are kept, but get()/update() can only address the older one.
  private reportCollision(id: string): void {
    if (this.reportedCollisions.has(id)) return;
    this.reportedCollisions.add(id);
    console.error(
      `dispatchd: finding id ${id} belongs to more than one record in ${this.file}. ` +
        'Both are kept; edit the file to give the newer one a distinct id.'
    );
  }

  // Dropped rather than served: a shapeless record is one a fix round would
  // quote and a ruling would silently fail to reach.
  private reportInvalidLine(line: string): void {
    if (this.reportedInvalidLines.has(line)) return;
    this.reportedInvalidLines.add(line);
    console.error(
      `dispatchd: skipping a finding line missing required fields in ${this.file}: ${line.slice(0, 200)}`
    );
  }

  // Mirrors ScopeRequestRegistry.mintId: re-roll until the id is one no record
  // in the file already uses, since a 6-hex-char space collides in practice.
  private mintId(now: string): string {
    const taken = new Set(this.read().map((f) => f.id));
    for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt += 1) {
      const id = this.generateId(now);
      if (!taken.has(id)) return id;
    }
    throw new Error(
      `could not mint an unused finding id in ${MINT_ATTEMPTS} attempts`
    );
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
      id: this.mintId(now),
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
      raisedBy: input.raisedBy,
      // Spread rather than set, so a finding raised without one keeps exactly
      // the shape it had before reviewers were asked for a recommendation.
      ...(input.recommendation !== undefined
        ? { recommendation: input.recommendation }
        : {}),
      ...(input.files !== undefined ? { files: input.files } : {}),
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
