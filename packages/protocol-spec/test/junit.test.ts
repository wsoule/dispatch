import { describe, expect, it } from 'bun:test';

import { toJUnit } from '../src/junit.js';
import type { Report, VectorResult } from '../src/types.js';

const result = (
  id: string,
  level: VectorResult['level'],
  outcome: VectorResult['outcome'],
  reasons: string[] = []
): VectorResult => ({
  id,
  class: 'host-core',
  level,
  profile: 'core',
  outcome,
  reasons,
});

const report: Report = {
  dmp: '1.0.0-draft.1',
  kit: '1.0.0-draft.1',
  implementation: { name: 'x', version: '0.0.0' },
  claims: { core: 'fail' },
  classes: {
    'host-core': {
      pass: 1,
      fail: 2,
      skipped: 1,
      notApplicable: 1,
      shouldFailures: 1,
    },
  },
  vectors: [
    result('core.a.pass', 'MUST', 'pass'),
    result('core.a.fail', 'MUST', 'fail', ['expected <a & "b">']),
    result('core.a.should', 'SHOULD', 'fail', ['no notice']),
    result('core.a.may', 'MAY', 'skipped', ['capability x not declared']),
    result('core.a.na', 'MUST', 'not-applicable', ['none left']),
  ],
  declaredDeviations: [],
  runner: '@dispatch/protocol-spec@1.0.0-draft.1',
  date: '2026-09-26T00:00:00.000Z',
};

// The <testcase> element for one vector id, up to its close.
function testcase(xml: string, id: string): string {
  const start = xml.indexOf(`name="${id}"`);
  const end = xml.indexOf('</testcase>', start);
  const selfClose = xml.indexOf('/>', start);
  return xml.slice(start, end === -1 ? selfClose : end);
}

describe('toJUnit', () => {
  const xml = toJUnit(report);

  it('writes one suite per class with its totals', () => {
    expect(xml).toContain('<testsuite name="host-core"');
    expect(xml).toContain('tests="5"');
    expect(xml).toContain('failures="1"');
    expect(xml.match(/<testsuite /g)).toHaveLength(1);
  });

  it('fails only the failing MUST', () => {
    expect(xml.match(/<failure /g)).toHaveLength(1);
    expect(testcase(xml, 'core.a.fail')).toContain('<failure ');
    expect(testcase(xml, 'core.a.pass')).not.toContain('<skipped');
  });

  it('skips the SHOULD, the MAY and the not-applicable vector with their reason', () => {
    expect(testcase(xml, 'core.a.should')).toContain(
      '<skipped message="SHOULD not met: no notice"'
    );
    expect(testcase(xml, 'core.a.may')).toContain(
      '<skipped message="skipped: capability x not declared"'
    );
    expect(testcase(xml, 'core.a.na')).toContain(
      '<skipped message="not-applicable: none left"'
    );
  });

  it('escapes markup in a reason and drops control characters', () => {
    expect(xml).toContain('expected &lt;a &amp; &quot;b&quot;&gt;');
    const bell = toJUnit({
      ...report,
      vectors: [result('core.a.bell', 'MUST', 'fail', ['ring\u0007 twice'])],
    });
    expect(bell).toContain('message="fail: ring twice"');
  });
});
