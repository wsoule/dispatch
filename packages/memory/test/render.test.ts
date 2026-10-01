import { describe, expect, it } from 'bun:test';

import { utf8Bytes } from '../src/limits.js';
import { newMemoryEntry } from '../src/records.js';
import { estimateTokens, indexLine, renderIndex } from '../src/render.js';
import type { MemoryEntry, MemoryKind } from '../src/types.js';

const NOW = '2026-09-25T10:00:00.000Z';
const ctx = { taskId: 't-1a2b3c', epic: 'e-000001' };
let n = 0;
function e(over: Partial<MemoryEntry> & { title?: string } = {}): MemoryEntry {
  n += 1;
  const base = newMemoryEntry(
    {
      scope: 'team',
      kind: 'hazard',
      title: `lesson ${n}`,
      body: 'detail',
      author: 'run:r-1',
      trust: 'agent',
    },
    `mem-${String(n).padStart(26, '0')}`,
    NOW
  );
  return { ...base, ...over };
}

// Deterministic PRNG so a failing seed reproduces.
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POOLS = [
  'abc xyz ',
  '漢字仮名交じり',
  '🧠🔥👩‍💻',
  'é',
  '\n## Evil\n',
  '~~~~',
  '"*:-(',
  ' NEAR AND OR ',
];
const KINDS: MemoryKind[] = [
  'constraint',
  'hazard',
  'decision',
  'convention',
  'fact',
  'reference',
];

function randomText(rand: () => number, maxChars: number): string {
  let out = '';
  const count = Math.floor(rand() * maxChars);
  for (let i = 0; i < count; i++) {
    const pool = Array.from(POOLS[Math.floor(rand() * POOLS.length)]);
    out += pool[Math.floor(rand() * pool.length)];
  }
  return out;
}

describe('renderIndex', () => {
  it('returns no section when nothing reaches the task', () => {
    expect(
      renderIndex([], { budgetTokens: 1000, variant: 'tools', ctx }).text
    ).toBeNull();
  });

  it('prints the kind, reach tags, unreviewed marker and handle', () => {
    const line = indexLine(
      e({
        kind: 'hazard',
        epic: 'e-000001',
        trust: 'agent',
        title: 'pnpm 11 ignores onlyBuiltDependencies',
      }),
      ctx
    );
    expect(line).toMatch(
      /^- hazard · epic · unreviewed: pnpm 11 ignores onlyBuiltDependencies \(#[0-9A-Z]{8}\)$/
    );
    expect(
      indexLine(
        e({
          scope: 'personal',
          kind: 'preference',
          trust: 'human',
          title: 'terse comments',
        }),
        ctx
      )
    ).toMatch(/^- preference · you: terse comments/);
    expect(
      indexLine(
        e({ scope: 'project', appliesTo: ['t-1a2b3c'], trust: 'confirmed' }),
        ctx
      )
    ).toMatch(/^- hazard · local · task: /);
  });

  // 600 bytes: the ~204-byte header, one short line and one 226-byte line fit;
  // the second long line does not, and the short line after it is never tried.
  it('stops at the first line that does not fit, never skipping ahead', () => {
    const first = e();
    const long1 = e({ title: 'x'.repeat(190) });
    const long2 = e({ title: 'y'.repeat(190) });
    const short = e({ title: 'short' });
    const out = renderIndex([first, long1, long2, short], {
      budgetTokens: 200,
      variant: 'tools',
      ctx,
    });
    expect(out.included).toEqual([first, long1]);
    expect(out.omitted).toBe(2);
    expect(out.text).toContain('(2 more not shown; memory_search finds them)');
    expect(out.text).not.toContain(': short (');
    expect(
      renderIndex([first, long1, long2, short], {
        budgetTokens: 4000,
        variant: 'tools',
        ctx,
      }).included
    ).toHaveLength(4);
  });

  it('cuts the lowest-ranked pins when pins alone exceed the budget', () => {
    const pins = Array.from({ length: 40 }, () =>
      e({ pinned: true, title: 'p'.repeat(150) })
    );
    const out = renderIndex(pins, { budgetTokens: 200, variant: 'tools', ctx });
    expect(out.pinnedOverflow).toBe(true);
    expect(out.included).toEqual(pins.slice(0, out.included.length));
  });

  it('puts a cut body under class-3 lines only, in the no-tools variant', () => {
    const hazard = e({ kind: 'hazard', body: `${'b'.repeat(400)}\n# heading` });
    const fact = e({ kind: 'fact', body: 'fact body' });
    const out = renderIndex([hazard, fact], {
      budgetTokens: 4000,
      variant: 'no-tools',
      ctx,
    });
    expect(out.text).not.toContain('memory_read');
    expect(out.text).toContain(`\n  ${'b'.repeat(300)}`);
    expect(out.text).not.toContain('b'.repeat(301));
    expect(out.text).not.toContain('fact body');
  });

  it('notes unavailable personal memory', () => {
    expect(
      renderIndex([], {
        budgetTokens: 1000,
        variant: 'tools',
        ctx,
        personalUnavailable: true,
      }).text
    ).toContain('(personal memory unavailable)');
  });

  // Review Focus 3: hostile and multi-byte text never breaks the budget or the structure.
  it('never exceeds 3 × indexTokens bytes and never lets a title start a line', () => {
    const rand = mulberry32(20260925);
    for (let trial = 0; trial < 300; trial++) {
      const budgetTokens = 200 + Math.floor(rand() * 3800);
      const entries = Array.from({ length: Math.floor(rand() * 60) }, () =>
        e({
          kind: KINDS[Math.floor(rand() * KINDS.length)],
          title: randomText(rand, 120),
          body: randomText(rand, 600),
          pinned: rand() < 0.1,
          trust: rand() < 0.5 ? 'agent' : 'human',
        })
      );
      for (const variant of ['tools', 'no-tools'] as const) {
        const out = renderIndex(entries, { budgetTokens, variant, ctx });
        if (out.text === null) continue;
        expect(utf8Bytes(out.text)).toBeLessThanOrEqual(3 * budgetTokens);
        expect(estimateTokens(out.text)).toBeLessThanOrEqual(budgetTokens);
        const [header, ...rest] = out.text.split('\n');
        expect(header).toBe('## Memory');
        for (const line of rest)
          expect(/^\s*(#{1,6}[ \t]|~{4,})/.test(line)).toBe(false);
      }
    }
    // Hundreds of renders run past bun's 5 s default on a loaded machine.
  }, 30_000);
});
