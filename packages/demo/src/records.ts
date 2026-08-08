import { formatActorRef } from '@dispatch/core';
import type { Finding, LedgerEntry } from '@dispatch/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ACTORS, OWNER } from './paths.js';

// Same fixed instant board.ts anchors on, so every record across the fixture
// shares one clock and regenerating stays byte-identical.
const BASE_MS = Date.parse('2026-07-28T14:00:00.000Z');

function ago(days: number, hours = 0): string {
  return new Date(BASE_MS - days * 86400000 - hours * 3600000).toISOString();
}

// The owner drives every dispatched review in the demo narrative; teammates
// are only ever credited as task assignees (see board.ts's ACTIVITY).
const REVIEWER = formatActorRef({
  kind: 'agent',
  handle: 'claude',
  operator: OWNER.handle,
});

// Six findings against the two in-review tasks — three severities, four
// verdicts, one many-file finding, one that blocks. `file`/`line` point at
// the fix branches' own content (BRANCH_FIXES in repo.ts), since that is the
// code a reviewer actually sees in the diff, not the unfixed main version.
// Exported so runs.ts's review-run transcript can reference these by id
// instead of hardcoding a second copy that could silently drift from these.
export const FINDINGS: Finding[] = [
  {
    id: 'f-a1b2c3',
    taskId: 't-2e91aa',
    runId: null,
    severity: 'critical',
    verdict: 'open',
    title: 'loadCart has no fallback if the session query rejects',
    detail:
      'query() can reject (dropped connection, timeout); loadCart only guards the JSON.parse branch, so a rejected promise still throws through to the caller instead of returning an empty cart the way the old localStorage version did.',
    file: 'src/cart/CartProvider.ts',
    line: 11,
    ruling: null,
    round: 0,
    createdAt: ago(3, 2),
    updatedAt: ago(3, 2),
    raisedBy: REVIEWER,
  },
  {
    id: 'f-b2c3d4',
    taskId: 't-2e91aa',
    runId: null,
    severity: 'important',
    verdict: 'addressed',
    title:
      "raw session payload isn't checked against a shape before being trusted as CartLine[]",
    detail:
      'JSON.parse(raw) is cast straight to CartLine[] with no runtime check; a corrupted session row would silently hand the client garbage. Guard sku/qty before returning.',
    file: 'src/cart/CartProvider.ts',
    line: 15,
    ruling: null,
    round: 0,
    createdAt: ago(3, 2),
    updatedAt: ago(3, 0),
    raisedBy: REVIEWER,
  },
  {
    id: 'f-c3d4e5',
    taskId: 't-2e91aa',
    runId: null,
    severity: 'minor',
    verdict: 'parked',
    title: 'CartLine has no unit price, so totals get recomputed elsewhere',
    detail:
      'Session cart lines only carry sku/qty; every consumer refetches price to compute a total. Worth carrying price alongside qty once the schema is touched again.',
    file: 'src/cart/CartProvider.ts',
    line: 5,
    ruling:
      'Parked — real scope creep for this task; file a follow-up against the checkout epic instead of blocking t-2e91aa on a schema change.',
    round: 0,
    createdAt: ago(3, 2),
    updatedAt: ago(2, 20),
    raisedBy: REVIEWER,
  },
  {
    id: 'f-d4e5f6',
    taskId: 't-58cc03',
    runId: null,
    severity: 'critical',
    verdict: 'blocked',
    title: 'EXACT_SKU_BOOST is a flat constant, not a real ceiling',
    detail:
      'overlap is unbounded — a long title with 100+ shared tokens can out-score an exact SKU match, since EXACT_SKU_BOOST is a fixed 100 rather than derived from the maximum possible overlap. Scale it off terms.length so the boost always wins.',
    file: 'src/search/rank.ts',
    line: 23,
    ruling:
      'Blocking — ranking correctness is the whole point of this task; ship the boost as a real ceiling, not a constant, before this merges.',
    round: 1,
    recommendation: 'blocks',
    createdAt: ago(1, 4),
    updatedAt: ago(1, 2),
    raisedBy: REVIEWER,
  },
  {
    id: 'f-e5f6a7',
    taskId: 't-58cc03',
    runId: null,
    severity: 'important',
    verdict: 'open',
    title: 'Empty query still runs a full scan instead of short-circuiting',
    detail:
      "tokenize('') returns [], so overlap is 0 for every product and nothing is pushed — but rank() still iterates the entire catalog to find that out. Return early when terms.length === 0.",
    file: 'src/search/rank.ts',
    line: 17,
    ruling: null,
    round: 0,
    createdAt: ago(2, 3),
    updatedAt: ago(2, 3),
    raisedBy: REVIEWER,
  },
  {
    id: 'f-f6a7b8',
    taskId: 't-58cc03',
    runId: null,
    severity: 'minor',
    verdict: 'addressed',
    title: "Tied scores rely on Array.sort's stability without saying so",
    detail:
      'Two fuzzy hits with equal overlap keep their query-order position only because Array.prototype.sort is spec-stable; a comment would save the next reader from re-deriving that.',
    file: 'src/search/rank.ts',
    line: 26,
    ruling: null,
    round: 0,
    createdAt: ago(2, 3),
    updatedAt: ago(2, 1),
    raisedBy: REVIEWER,
  },
  {
    id: 'f-a7b8c9',
    taskId: 't-58cc03',
    runId: null,
    severity: 'important',
    verdict: 'open',
    title:
      'Nothing in the search path normalizes non-breaking spaces or diacritics consistently',
    detail:
      'tokenize() lowercases and splits on [^a-z0-9-]+, so a copy-pasted SKU with an NBSP or accented character silently falls out of both the exact-match and fuzzy-overlap paths across rank.ts, index.ts, and tokenize.ts. Needs one shared normalization pass.',
    file: 'src/search/rank.ts',
    line: 20,
    files: [
      'src/search/rank.ts',
      'src/search/index.ts',
      'src/search/tokenize.ts',
    ],
    ruling: null,
    round: 2,
    createdAt: ago(0, 6),
    updatedAt: ago(0, 6),
    raisedBy: REVIEWER,
  },
];

// One of each ledger kind, scoped a mix of per-epic and project-wide.
const LEDGER: LedgerEntry[] = [
  {
    id: 'l-1a2b3c',
    epicId: 'e-4a19c2',
    sourceTaskId: 't-2e91aa',
    kind: 'constraint',
    title: 'Session store is the single source of cart truth',
    detail:
      'Once cart state moves server-side, no code path may write cart lines to localStorage — the whole point of t-2e91aa. Any future checkout task that touches cart state must read from the session store.',
    appliesTo: ['t-6c40de'],
    createdAt: ago(3, 1),
    authoredBy: formatActorRef({
      kind: 'human',
      handle: OWNER.handle,
      operator: null,
    }),
  },
  {
    id: 'l-b2c3d4',
    epicId: 'e-77b3e1',
    sourceTaskId: 't-58cc03',
    kind: 'hazard',
    title: 'EXACT_SKU_BOOST is a flat constant, not a real ceiling',
    detail:
      'Flagged in review (finding f-d4e5f6): a title with enough overlapping tokens can out-score an exact SKU match. Anyone touching ranking again should check this has not regressed.',
    appliesTo: [],
    createdAt: ago(1, 2),
    authoredBy: REVIEWER,
  },
  {
    id: 'l-c3d4e5',
    epicId: null,
    sourceTaskId: null,
    kind: 'decision',
    title:
      'Discount codes move fully server-side before the checkout rewrite ships',
    detail:
      'Decided during the Checkout rewrite epic: client-side discount validation is being retired repo-wide, not just for t-3f8a21 — no new code should re-add a client-trusted discount check.',
    appliesTo: [],
    createdAt: ago(4, 0),
    authoredBy: formatActorRef({
      kind: 'human',
      handle: OWNER.handle,
      operator: null,
    }),
  },
  {
    id: 'l-d4e5f6',
    epicId: 'e-4a19c2',
    sourceTaskId: 't-2e91aa',
    kind: 'handoff',
    title: 'Cart session schema handed off to t-6c40de',
    detail:
      't-2e91aa lands CartLine{sku,qty} keyed by sessionId in the session store; t-6c40de can build cross-device persistence directly on top of loadCart/saveCart without touching the schema again.',
    appliesTo: ['t-6c40de'],
    createdAt: ago(3, 0),
    authoredBy: formatActorRef({
      kind: 'agent',
      handle: 'claude',
      operator: 'dokafor',
    }),
  },
];

function writeFindings(root: string): void {
  const dir = join(root, '.dispatch');
  mkdirSync(dir, { recursive: true });
  const lines = FINDINGS.map((f) => JSON.stringify(f)).join('\n');
  writeFileSync(join(dir, 'findings.jsonl'), `${lines}\n`);
}

function writeLedger(root: string): void {
  const dir = join(root, '.dispatch');
  mkdirSync(dir, { recursive: true });
  const lines = LEDGER.map((l) => JSON.stringify(l)).join('\n');
  writeFileSync(join(dir, 'ledger.jsonl'), `${lines}\n`);
}

// One inbox item, formatted the way InboxStore.serializeItem does: prose,
// then `→ taskId`, then `@runId`, then `^id` last — the id marker must be
// the last thing on the line or the reader renders it as item text.
function inboxLine(opts: {
  done?: boolean;
  kind: string;
  text: string;
  taskId?: string;
  runId?: string;
  id: string;
}): string {
  const box = opts.done === true ? 'x' : ' ';
  const parts = [`- [${box}] (${opts.kind}) ${opts.text}`];
  if (opts.taskId !== undefined) parts.push(`→ ${opts.taskId}`);
  if (opts.runId !== undefined) parts.push(`@${opts.runId}`);
  parts.push(`^${opts.id}`);
  return parts.join(' ');
}

const HEADER = [
  '# Inbox',
  '',
  'Captured, not committed. Edit this file freely — add a `- [ ] your thought`',
  'line anywhere and Dispatch will pick it up.',
  '',
];

// The six items from .agents/ignore/gen-demo.py lines 69-77, carried over
// for the owner's inbox. The original script's last line put `^in-a6` before
// `→ t-71ff03`, which the real parser reads as item text, not a marker — that
// bug is fixed here by moving the id marker last.
function ownerInbox(): string {
  const lines = [
    ...HEADER,
    inboxLine({
      kind: 'bug',
      text: 'checkout spinner never stops if stripe times out',
      id: 'in-a1',
    }),
    inboxLine({
      kind: 'idea',
      text: 'maybe cache the search index in redis',
      id: 'in-a2',
    }),
    inboxLine({
      kind: 'bug',
      text: 'search returns nothing for hyphenated skus',
      runId: 'r-3d90c1',
      id: 'in-a3',
    }),
    inboxLine({
      kind: 'task',
      text: 'need to add rate limiting to the search endpoint',
      id: 'in-a4',
    }),
    inboxLine({
      kind: 'note',
      text: 'search index rebuild takes 40 minutes',
      id: 'in-a5',
    }),
    inboxLine({
      done: true,
      kind: 'task',
      text: 'add a /health endpoint',
      taskId: 't-71ff03',
      id: 'in-a6',
    }),
    '',
  ];
  return lines.join('\n');
}

function teammateInbox(handle: string): string {
  if (handle === 'pmirand') {
    const lines = [
      ...HEADER,
      inboxLine({
        kind: 'idea',
        text: 'price discount checks through one shared server-side helper instead of duplicating per endpoint',
        id: 'in-b1',
      }),
      inboxLine({
        kind: 'note',
        text: 'redis cache TTL should match session TTL once this lands',
        taskId: 't-1d77e5',
        id: 'in-b2',
      }),
      inboxLine({
        done: true,
        kind: 'task',
        text: 'fix hyphenated SKU search',
        taskId: 't-0c9b88',
        id: 'in-b3',
      }),
      '',
    ];
    return lines.join('\n');
  }
  // dokafor
  const lines = [
    ...HEADER,
    inboxLine({
      kind: 'task',
      text: 'wire the address field to the places API',
      taskId: 't-9b2d14',
      id: 'in-c1',
    }),
    inboxLine({
      kind: 'idea',
      text: 'maybe rate limit search by session instead of raw IP',
      taskId: 't-8ac410',
      id: 'in-c2',
    }),
    inboxLine({
      kind: 'note',
      text: 'session-store review left an open finding on error handling',
      id: 'in-c3',
    }),
    '',
  ];
  return lines.join('\n');
}

function writeInboxes(root: string): void {
  const dir = join(root, '.dispatch', 'inbox');
  mkdirSync(dir, { recursive: true });
  for (const actor of ACTORS) {
    const content =
      actor.handle === OWNER.handle
        ? ownerInbox()
        : teammateInbox(actor.handle);
    writeFileSync(join(dir, `${actor.handle}.md`), content);
  }
}

/** Seeds `.dispatch/findings.jsonl`, `.dispatch/ledger.jsonl`, and one inbox file per actor. */
export function writeRecords(root: string): void {
  writeFindings(root);
  writeLedger(root);
  writeInboxes(root);
}
