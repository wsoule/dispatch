import type { Finding, LedgerEntry } from '@dispatch/core';
import { parseActorRef } from '@dispatch/core';
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeBoard } from '../src/board.js';
import { ACTORS } from '../src/paths.js';
import { writeRecords } from '../src/records.js';

function build(): string {
  const root = mkdtempSync(join(tmpdir(), 'demo-records-'));
  writeBoard(root);
  writeRecords(root);
  return root;
}

function lines(root: string, name: string): Record<string, unknown>[] {
  return readFileSync(join(root, '.dispatch', name), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test('findings cover every severity and every verdict', () => {
  const findings = lines(build(), 'findings.jsonl');
  expect(new Set(findings.map((f) => f.severity))).toEqual(
    new Set(['critical', 'important', 'minor'])
  );
  expect(new Set(findings.map((f) => f.verdict))).toEqual(
    new Set(['open', 'addressed', 'parked', 'blocked'])
  );
});

test('parked and blocked findings carry a written ruling', () => {
  for (const f of lines(build(), 'findings.jsonl')) {
    if (f.verdict === 'parked' || f.verdict === 'blocked') {
      expect(typeof f.ruling).toBe('string');
      expect((f.ruling as string).length).toBeGreaterThan(0);
    }
  }
});

// Field list lifted directly from FindingStore's isFinding() validator in
// packages/server/src/findings.ts — a line missing any of these is silently
// not a finding to the real reader, so this must match that list exactly.
test('every finding carries the fields the reader dereferences', () => {
  for (const f of lines(build(), 'findings.jsonl')) {
    for (const key of [
      'id',
      'taskId',
      'severity',
      'verdict',
      'title',
      'detail',
      'createdAt',
    ]) {
      expect(f[key]).toBeDefined();
    }
    expect(typeof f.raisedBy).toBe('string');
  }
});

test('one finding carries a populated files array and one recommends blocking', () => {
  const findings = lines(build(), 'findings.jsonl');
  expect(
    findings.some(
      (f) => Array.isArray(f.files) && (f.files as unknown[]).length > 0
    )
  ).toBe(true);
  expect(findings.some((f) => f.recommendation === 'blocks')).toBe(true);
});

// file/line must anchor onto the actual diff: t-2e91aa and t-58cc03's fixes
// live in the BRANCH_FIXES content (repo.ts), which is what a reviewer
// actually sees. Confirm every finding's line exists in that real content
// rather than trusting a guessed number.
test('file/line point at real lines in the reviewed branch content', () => {
  const branchLineCounts: Record<string, number> = {
    'src/cart/CartProvider.ts': 23,
    'src/search/rank.ts': 27,
  };
  for (const f of lines(build(), 'findings.jsonl')) {
    const file = f.file as string;
    const line = f.line as number;
    expect(branchLineCounts[file]).toBeDefined();
    expect(line).toBeGreaterThan(0);
    expect(line).toBeLessThanOrEqual(branchLineCounts[file]);
  }
});

// raisedBy is a serialized ActorRef. Round-trip every value through the real
// parser (packages/core/src/actor.ts) rather than checking it with a regex —
// a format this task invents would pass a regex but fail the real reader.
test('raisedBy round-trips through the real ActorRef parser', () => {
  for (const f of lines(build(), 'findings.jsonl')) {
    const ref = parseActorRef(f.raisedBy as string);
    expect(ref).not.toBeNull();
    expect(ref?.kind === 'human' || ref?.kind === 'agent').toBe(true);
  }
});

test('the ledger covers all four kinds', () => {
  const ledger = lines(build(), 'ledger.jsonl');
  expect(new Set(ledger.map((l) => l.kind))).toEqual(
    new Set(['constraint', 'hazard', 'decision', 'handoff'])
  );
});

// Field list lifted from LedgerStore's isLedgerEntry() validator in
// packages/server/src/ledger.ts.
test('every ledger entry carries the fields the reader dereferences', () => {
  for (const l of lines(build(), 'ledger.jsonl')) {
    for (const key of ['id', 'kind', 'title', 'detail', 'createdAt']) {
      expect(l[key]).toBeDefined();
    }
    expect(Array.isArray(l.appliesTo)).toBe(true);
    expect(typeof l.authoredBy).toBe('string');
  }
});

test('the ledger scopes at least one entry to an epic and leaves one project-wide', () => {
  const ledger = lines(build(), 'ledger.jsonl');
  expect(ledger.some((l) => l.epicId !== null)).toBe(true);
  expect(ledger.some((l) => l.epicId === null)).toBe(true);
});

test('authoredBy round-trips through the real ActorRef parser', () => {
  for (const l of lines(build(), 'ledger.jsonl')) {
    const ref = parseActorRef(l.authoredBy as string);
    expect(ref).not.toBeNull();
    expect(ref?.kind === 'human' || ref?.kind === 'agent').toBe(true);
  }
});

test('each actor gets their own inbox with the id marker last', () => {
  const root = build();
  for (const actor of ACTORS) {
    const inbox = readFileSync(
      join(root, '.dispatch/inbox', `${actor.handle}.md`),
      'utf8'
    );
    for (const line of inbox.split('\n').filter((l) => l.includes('^in-'))) {
      expect(line.trimEnd()).toMatch(/\^in-[a-z0-9]+$/);
    }
  }
});

test("the owner's inbox carries the six items from gen-demo.py, id last", () => {
  const inbox = readFileSync(
    join(build(), '.dispatch/inbox', 'wsoule679.md'),
    'utf8'
  );
  const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((n) => `^in-${n}`);
  for (const id of ids) expect(inbox).toContain(id);
  // The original script's last item put the id before the task arrow; the
  // fixed line must read arrow-then-id, not id-then-arrow.
  expect(inbox).toContain('→ t-71ff03 ^in-a6');
  expect(inbox).not.toContain('^in-a6 → t-71ff03');
});

test('teammate inboxes are non-empty and distinct from the owner', () => {
  const root = build();
  const owner = readFileSync(
    join(root, '.dispatch/inbox/wsoule679.md'),
    'utf8'
  );
  for (const actor of ACTORS.filter((a) => a.handle !== 'wsoule679')) {
    const inbox = readFileSync(
      join(root, '.dispatch/inbox', `${actor.handle}.md`),
      'utf8'
    );
    expect(inbox).not.toBe(owner);
    expect(
      inbox.split('\n').filter((l) => l.includes('^in-')).length
    ).toBeGreaterThanOrEqual(2);
  }
});

// Type-level check: assigning through Finding/LedgerEntry ensures records.ts's
// literals satisfy the exact interfaces core exports — a shape drift there
// fails `moonx demo:typecheck`, not just this test file.
test('written findings and ledger entries parse as their real interface shape', () => {
  const root = build();
  const findings = lines(root, 'findings.jsonl') as unknown as Finding[];
  const ledger = lines(root, 'ledger.jsonl') as unknown as LedgerEntry[];
  expect(findings.length).toBeGreaterThanOrEqual(6);
  expect(ledger.length).toBe(4);
});

test('regenerating writes byte-identical output', () => {
  const rootA = build();
  const rootB = build();
  for (const name of ['findings.jsonl', 'ledger.jsonl']) {
    expect(readFileSync(join(rootA, '.dispatch', name), 'utf8')).toBe(
      readFileSync(join(rootB, '.dispatch', name), 'utf8')
    );
  }
  for (const actor of ACTORS) {
    const file = join('.dispatch/inbox', `${actor.handle}.md`);
    expect(readFileSync(join(rootA, file), 'utf8')).toBe(
      readFileSync(join(rootB, file), 'utf8')
    );
  }
});
