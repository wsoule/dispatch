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

// '# a' and then copies of `line`, up to 4 KiB short of the body cap.
function capBody(line: string): string {
  const copies = Math.floor((768 * 1024 - 4096) / Buffer.byteLength(line));
  return `# a\n${line.repeat(copies)}`;
}

// Heading text whose anchor costs far more per byte than prose does.
const COSTLY_HEADINGS: readonly [string, string][] = [
  ['two-byte letters', 'İ'.repeat(1500)],
  ['a long run of blanks', `x${' '.repeat(3000)}x`],
  ['alternating blanks and hashes', ' #'.repeat(1500)],
];

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

  it('runs all 50 section ops over a cap-sized prose doc', () => {
    const doc = { title: 'Corpus', body: corpusLines().join('') };
    const ops = sectionAppends(50, '#section-0');
    expect(
      applyOps(doc, ops).body.includes(`${'x\n'.repeat(50)}## Section 1\n`)
    ).toBe(true);
    expect(timed(() => applyOps(doc, ops))).toBeLessThan(1000);
  });

  for (const [shape, text] of COSTLY_HEADINGS) {
    it(`prices heading text by its length: ${shape}`, () => {
      const doc = { title: 'a', body: capBody(`## ${text}\n`) };
      const ops = sectionAppends(50, '#a');
      expect(() => applyOps(doc, ops)).toThrow('these ops scan');
      expect(timed(() => applyOps(doc, ops))).toBeLessThan(1000);
    });
  }

  it('prices lines that could open a fence', () => {
    const doc = { title: 'a', body: capBody('- ```\n') };
    const ops = sectionAppends(50, '#a');
    expect(() => applyOps(doc, ops)).toThrow('these ops scan');
    expect(timed(() => applyOps(doc, ops))).toBeLessThan(1000);
  });

  it('finds text in linear time however the body repeats', () => {
    const find = `${'ab'.repeat(2047)}ba${'ab'.repeat(2048)}`;
    const body = `# a\n${'ab'.repeat(380_000)}${find}\n`;
    const ops: DocOp[] = Array.from({ length: 50 }, () => ({
      op: 'replace',
      find,
      text: find,
    }));
    let result = '';
    const ms = timed(() => {
      result = applyOps({ title: 'a', body }, ops).body;
    });
    expect(result).toBe(body);
    expect(ms).toBeLessThan(1000);
  });

  it('prices short lines inside fenced code', () => {
    const body = capBody('  x\n').replace('# a\n', '# a\n```\n');
    const ops = sectionAppends(50, '#a');
    expect(() => applyOps({ title: 'a', body }, ops)).toThrow('these ops scan');
    expect(timed(() => applyOps({ title: 'a', body }, ops))).toBeLessThan(1000);
  });
});
