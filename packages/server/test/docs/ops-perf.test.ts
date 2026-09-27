import type { DocOp } from '@dispatch/core';
import { describe, expect, it } from 'bun:test';

import { applyOps } from '../../src/docs/ops.js';
import { corpusLines } from './corpus.js';

// Milliseconds `fn` took, whether it returned or threw.
function timed(fn: () => unknown): number {
  const started = performance.now();
  try {
    fn();
  } catch {
    // The caller asserts on the error separately.
  }
  return performance.now() - started;
}

const sectionAppends = (n: number, section: string): DocOp[] =>
  Array.from({ length: n }, () => ({ op: 'append', section, text: 'x' }));

describe('review focus 2: one ops call stays bounded at the cap', () => {
  it('refuses a body grown past the cap before running the ops after it', () => {
    const doc = { title: 'x', body: '# x\n' };
    const ops: DocOp[] = [
      { op: 'append', text: '#\n'.repeat(500_000) },
      ...sectionAppends(49, 'x'),
    ];
    expect(() => applyOps(doc, ops)).toThrow(
      'ops[0]: the body would be over 768 KiB'
    );
    expect(timed(() => applyOps(doc, ops))).toBeLessThan(500);
  });

  it('refuses section ops on a heading-dense body before outlining it', () => {
    const doc = { title: 'a', body: '# a\n'.repeat(196_000) };
    const ops = sectionAppends(50, '#a');
    expect(() => applyOps(doc, ops)).toThrow('ops[0]: these ops scan');
    expect(timed(() => applyOps(doc, ops))).toBeLessThan(500);
  });

  it('appends at the doc end without splitting a cap-sized body', () => {
    const doc = { title: 'a', body: '\n'.repeat(786_000) };
    const ops: DocOp[] = Array.from({ length: 50 }, () => ({
      op: 'append',
      text: 'x',
    }));
    expect(applyOps(doc, ops).body.endsWith('\nx\n')).toBe(true);
    expect(timed(() => applyOps(doc, ops))).toBeLessThan(500);
  });

  it('stops a heading-dense body after the section op the budget admits', () => {
    const doc = { title: 'a', body: '# a\n'.repeat(110_000) };
    expect(
      applyOps(doc, sectionAppends(1, '#a')).body.startsWith('# a\nx\n')
    ).toBe(true);
    expect(() => applyOps(doc, sectionAppends(50, '#a'))).toThrow(
      'ops[1]: these ops scan'
    );
    expect(timed(() => applyOps(doc, sectionAppends(50, '#a')))).toBeLessThan(
      1000
    );
  });

  it('spends at most the budget on section ops over a cap-sized prose doc', () => {
    const doc = { title: 'Corpus', body: corpusLines().join('') };
    const ops = sectionAppends(50, '#section-0');
    expect(() => applyOps(doc, ops)).toThrow('these ops scan');
    expect(timed(() => applyOps(doc, ops))).toBeLessThan(1000);
    expect(
      applyOps(doc, sectionAppends(5, '#section-0')).body.includes(
        `${'x\n'.repeat(5)}## Section 1\n`
      )
    ).toBe(true);
  });
});
