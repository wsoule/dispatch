import { describe, expect, it } from 'bun:test';

import { driftProblems } from '../src/drift.js';
import type { RegistryEntry } from '../src/registries.js';

function entry(value: string, status: RegistryEntry['status']): RegistryEntry {
  return {
    value,
    scope: 'core',
    status,
    since: '1.0.0-draft.1',
    section: '5.9',
    vectors: status === 'permanent' ? ['core.x.y'] : [],
  };
}

describe('driftProblems (permanent ⊆ export ⊆ permanent ∪ provisional)', () => {
  it('passes when the export equals the permanent entries', () => {
    expect(
      driftProblems('gate-types', [entry('wake', 'permanent')], ['wake'])
    ).toEqual([]);
  });

  it('lets a sub-project export a value the registry lists as provisional', () => {
    expect(
      driftProblems(
        'gate-types',
        [entry('wake', 'permanent'), entry('memory', 'provisional')],
        ['wake', 'memory']
      )
    ).toEqual([]);
  });

  it('fails an exported value with no entry', () => {
    expect(
      driftProblems('gate-types', [entry('wake', 'permanent')], ['wake', 'doc'])
    ).toEqual([
      'gate-types: doc is exported but has no permanent or provisional entry',
    ]);
  });

  it('fails a permanent entry missing from the export', () => {
    expect(driftProblems('kinds', [entry('notice', 'permanent')], [])).toEqual([
      'kinds: notice is permanent but not exported',
    ]);
  });

  it('never lets an informative, appendix or reserved value into the export', () => {
    const entries = [
      entry('unavailable', 'informative'),
      entry('forwarded', 'appendix'),
      entry('@', 'reserved'),
    ];
    expect(
      driftProblems('x', entries, ['unavailable', 'forwarded', '@'])
    ).toHaveLength(3);
  });
});
