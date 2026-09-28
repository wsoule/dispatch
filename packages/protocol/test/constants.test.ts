import {
  driftProblems,
  ENGINE_REGISTRIES,
  loadRegistry,
} from '@dispatch/protocol-spec';
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import * as browser from '../src/browser.js';
import {
  ADDRESS_SCHEMES,
  BUILT_IN_KINDS,
  DELIVERY_STATES,
  ERROR_CODES,
  GATE_RAISERS,
  GATE_TYPES,
  MARKERS,
  REF_TYPES,
} from '../src/constants.js';

const registry = loadRegistry();
const EXPORTS: Record<string, readonly string[]> = {
  'address-schemes': ADDRESS_SCHEMES,
  kinds: BUILT_IN_KINDS,
  'ref-types': REF_TYPES,
  'gate-types': GATE_TYPES,
  'system-markers': MARKERS,
  'delivery-states': DELIVERY_STATES,
  'error-codes': Object.keys(ERROR_CODES),
};

describe('registry exports (C4)', () => {
  for (const name of ENGINE_REGISTRIES) {
    it(`${name}: permanent ⊆ export ⊆ permanent ∪ provisional`, () => {
      expect(driftProblems(name, registry[name], EXPORTS[name] ?? [])).toEqual(
        []
      );
    });
  }

  it("GATE_RAISERS agrees with every gate type's raisedBy", () => {
    for (const g of registry['gate-types']) {
      expect({
        type: g.value,
        raiser: GATE_RAISERS[g.value] ?? 'system',
      }).toEqual({ type: g.value, raiser: g.raisedBy ?? 'system' });
    }
  });

  it("ERROR_CODES carry each engine code's HTTP status and nothing informative", () => {
    const engine = registry['error-codes'].filter(
      (e) => e.status === 'permanent'
    );
    expect(
      Object.fromEntries(engine.map((e) => [e.value, e.httpStatus]))
    ).toEqual({ ...ERROR_CODES });
    expect('unavailable' in ERROR_CODES).toBe(false);
  });

  it('the browser entry is exactly the constants module', () => {
    expect(Object.keys(browser).sort()).toEqual([
      'ADDRESS_SCHEMES',
      'BUILT_IN_KINDS',
      'DELIVERY_STATES',
      'ERROR_CODES',
      'GATE_RAISERS',
      'GATE_TYPES',
      'MARKERS',
      'MAX_ADDRESS_BYTES',
      'MAX_SEGMENT_BYTES',
      'REF_TYPES',
      'SYSTEM_ADDRESS',
      'gateTypeOf',
      'hasGateData',
      'raiserOf',
    ]);
  });

  it('shares one line-break set with the kit', () => {
    const mine = readFileSync(
      new URL('../src/lines.ts', import.meta.url),
      'utf8'
    );
    const kit = readFileSync(
      new URL('../../protocol-spec/src/lines.ts', import.meta.url),
      'utf8'
    );
    expect(kit).toBe(mine);
  });
});
