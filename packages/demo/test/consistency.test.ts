import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TASKS, writeBoard } from '../src/board.js';
import { runsDir } from '../src/paths.js';
import { writeRecords } from '../src/records.js';
import { BRANCH_FIXES } from '../src/repo.js';
import { writeRuns } from '../src/runs.js';

// ---------------------------------------------------------------------------
// records.ts and runs.ts each hardcode ids/titles that board.ts's TASKS (and
// repo.ts's BRANCH_FIXES) actually own — a finding's taskId, a ledger
// entry's epicId/sourceTaskId/appliesTo, an inbox "→ t-…" reference, and a
// transcript's taskId/taskTitle. Every value happens to be correct today,
// but nothing asserts it, so an id typo or a title edit in board.ts would
// silently produce a stale run header or a dangling reference. This file
// cross-checks every one of those hardcoded references against the real
// TASKS list, so drift fails a test instead of shipping unnoticed.
// ---------------------------------------------------------------------------

function build(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'demo-consistency-root-'));
  const home = mkdtempSync(join(tmpdir(), 'demo-consistency-home-'));
  writeBoard(root);
  writeRecords(root);
  writeRuns(root, home, 'wsoule679');
  return { root, home };
}

const TASK_IDS = new Set(TASKS.map((t) => t.id));
const TITLE_BY_ID = new Map(TASKS.map((t) => [t.id, t.title]));

function jsonlLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test('every finding.taskId resolves to a real TASKS entry', () => {
  const { root } = build();
  const findings = jsonlLines(join(root, '.dispatch', 'findings.jsonl'));
  expect(findings.length).toBeGreaterThan(0);
  for (const f of findings) {
    expect(TASK_IDS.has(f.taskId as string)).toBe(true);
  }
});

test('every ledger epicId, sourceTaskId, and appliesTo entry resolves to a real TASKS entry', () => {
  const { root } = build();
  const ledger = jsonlLines(join(root, '.dispatch', 'ledger.jsonl'));
  expect(ledger.length).toBeGreaterThan(0);
  let sawEpicId = false;
  let sawSourceTaskId = false;
  let sawAppliesTo = false;
  for (const entry of ledger) {
    if (entry.epicId !== null) {
      sawEpicId = true;
      expect(TASK_IDS.has(entry.epicId as string)).toBe(true);
    }
    if (entry.sourceTaskId !== null) {
      sawSourceTaskId = true;
      expect(TASK_IDS.has(entry.sourceTaskId as string)).toBe(true);
    }
    for (const id of entry.appliesTo as string[]) {
      sawAppliesTo = true;
      expect(TASK_IDS.has(id)).toBe(true);
    }
  }
  // Confirms this test actually exercised all three fields rather than
  // passing vacuously because the seeded ledger happened to leave one empty.
  expect(sawEpicId).toBe(true);
  expect(sawSourceTaskId).toBe(true);
  expect(sawAppliesTo).toBe(true);
});

test('every inbox "→ t-…" reference resolves to a real TASKS entry', () => {
  const { root } = build();
  const dir = join(root, '.dispatch', 'inbox');
  let sawReference = false;
  for (const file of readdirSync(dir)) {
    const text = readFileSync(join(dir, file), 'utf8');
    for (const match of text.matchAll(/→ (t-[0-9a-f]+)/g)) {
      sawReference = true;
      expect(TASK_IDS.has(match[1] ?? '')).toBe(true);
    }
  }
  expect(sawReference).toBe(true);
});

test("every transcript's taskId resolves to a real TASKS entry, and taskTitle matches the board's title for that id", () => {
  const { root, home } = build();
  const dir = runsDir(root, home);
  let sawRun = false;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    const [header] = jsonlLines(join(dir, file));
    const meta = header?.meta as
      | { taskId: string; taskTitle: string }
      | undefined;
    expect(meta).toBeDefined();
    sawRun = true;
    expect(TASK_IDS.has(meta!.taskId)).toBe(true);
    const wantTitle = TITLE_BY_ID.get(meta!.taskId);
    expect(wantTitle).toBeDefined();
    expect(meta!.taskTitle).toBe(wantTitle!);
  }
  expect(sawRun).toBe(true);
});

test("a finding against a BRANCH_FIXES task cites that fix branch's own file", () => {
  const { root } = build();
  const findings = jsonlLines(join(root, '.dispatch', 'findings.jsonl'));
  let sawBranchFixFinding = false;
  for (const f of findings) {
    const fix = BRANCH_FIXES.find((b) => b.task === f.taskId);
    if (fix !== undefined) {
      sawBranchFixFinding = true;
      expect(f.file).toBe(fix.file);
    }
  }
  expect(sawBranchFixFinding).toBe(true);
});
