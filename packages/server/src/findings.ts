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

// How many times add() will re-roll an id before giving up. Far beyond what
// randomness needs; it only bounds a generator that keeps returning a taken id.
const MINT_ATTEMPTS = 32;

export class FindingStore {
  private readonly file: string;
  private readonly generateId: (now: string) => string;
  // Ids already reported as colliding, so a damaged file logs once, not on
  // every read.
  private readonly reportedCollisions = new Set<string>();

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
        const record = JSON.parse(line) as Finding;
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
