import { describe, expect, it } from 'bun:test';

import {
  consultFloor,
  consultPolicy,
  DEFAULT_POLICY,
  describeFloorHold,
  describePolicyAuthorization,
  effectiveRung,
  FLOOR_CHECKS,
  GATE_RUNGS,
  IRREVERSIBILITY_FLOOR,
  isFloorCheck,
  MAX_POLICY_RUNG,
  MIN_POLICY_RUNG,
  POLICY_GATES,
  POLICY_RUNGS,
  RISK_RUNG_CAPS,
} from '../src/policy.js';
import type { FloorCheck, PolicyRuling } from '../src/policy.js';

function auto(ruling: PolicyRuling): Extract<PolicyRuling, { mode: 'auto' }> {
  if (ruling.mode !== 'auto') throw new Error('expected an auto ruling');
  return ruling;
}

describe('the ladder tables', () => {
  it('every gate is assigned a rung on the ladder', () => {
    const rungs = new Set(POLICY_RUNGS.map((r) => r.rung));
    for (const gate of POLICY_GATES) {
      expect(rungs.has(GATE_RUNGS[gate])).toBe(true);
    }
  });

  it('the ladder spans MIN to MAX contiguously', () => {
    expect(POLICY_RUNGS.map((r) => r.rung)).toEqual(
      Array.from(
        { length: MAX_POLICY_RUNG - MIN_POLICY_RUNG + 1 },
        (_, i) => MIN_POLICY_RUNG + i
      )
    );
  });

  it('the default policy is the strictest rung with no pins', () => {
    expect(DEFAULT_POLICY).toEqual({ rung: MIN_POLICY_RUNG, gates: {} });
  });
});

describe('consultPolicy', () => {
  it('rung 1 blocks every gate — the strictest behavior', () => {
    for (const gate of POLICY_GATES) {
      expect(consultPolicy({ rung: 1, gates: {} }, gate)).toEqual({
        mode: 'block',
      });
    }
  });

  it('a gate demotes exactly at its assigned rung, not below', () => {
    for (const gate of POLICY_GATES) {
      const at = consultPolicy({ rung: GATE_RUNGS[gate], gates: {} }, gate);
      expect(at.mode).toBe('auto');
      const below = consultPolicy(
        { rung: GATE_RUNGS[gate] - 1, gates: {} },
        gate
      );
      expect(below.mode).toBe('block');
    }
  });

  it('the top rung demotes every gate', () => {
    for (const gate of POLICY_GATES) {
      const ruling = auto(
        consultPolicy({ rung: MAX_POLICY_RUNG, gates: {} }, gate)
      );
      expect(ruling.gate).toBe(gate);
      expect(ruling.rung).toBe(MAX_POLICY_RUNG);
      expect(ruling.authorizedBy).toBe('rung');
    }
  });

  it('a block pin re-promotes a gate the rung would demote', () => {
    expect(
      consultPolicy(
        { rung: MAX_POLICY_RUNG, gates: { scope: 'block' } },
        'scope'
      )
    ).toEqual({ mode: 'block' });
    // The pin is per-gate: the others stay demoted.
    expect(
      consultPolicy(
        { rung: MAX_POLICY_RUNG, gates: { scope: 'block' } },
        'merge'
      ).mode
    ).toBe('auto');
  });

  it('an auto pin demotes one gate without raising the rung', () => {
    const ruling = auto(
      consultPolicy({ rung: 1, gates: { merge: 'auto' } }, 'merge')
    );
    expect(ruling.authorizedBy).toBe('override');
    expect(ruling.rung).toBe(1);
    // Only the pinned gate: everything else still blocks at rung 1.
    expect(
      consultPolicy({ rung: 1, gates: { merge: 'auto' } }, 'scope')
    ).toEqual({ mode: 'block' });
  });
});

describe('the per-task risk cap', () => {
  it('routine leaves the project rung alone; elevated and critical lower it', () => {
    const top = { rung: MAX_POLICY_RUNG, gates: {} };
    expect(effectiveRung(top)).toBe(MAX_POLICY_RUNG);
    expect(effectiveRung(top, 'routine')).toBe(MAX_POLICY_RUNG);
    expect(effectiveRung(top, 'elevated')).toBe(RISK_RUNG_CAPS.elevated);
    expect(effectiveRung(top, 'critical')).toBe(RISK_RUNG_CAPS.critical);
    // Never raises: a rung-1 project stays at 1 for every risk.
    expect(effectiveRung({ rung: 1, gates: {} }, 'routine')).toBe(1);
  });

  it('a human always merges elevated work, even at the top rung', () => {
    const top = { rung: MAX_POLICY_RUNG, gates: {} };
    expect(consultPolicy(top, 'merge', 'elevated')).toEqual({ mode: 'block' });
    // The lower gates still demote, at the capped rung.
    const ruling = auto(consultPolicy(top, 'verify-retry', 'elevated'));
    expect(ruling.rung).toBe(RISK_RUNG_CAPS.elevated);
  });

  it('a critical task never auto-decides any gate', () => {
    const top = { rung: MAX_POLICY_RUNG, gates: {} };
    for (const gate of POLICY_GATES) {
      expect(consultPolicy(top, gate, 'critical')).toEqual({ mode: 'block' });
    }
  });

  it('the cap beats a per-gate auto pin', () => {
    const pinned = { rung: 1, gates: { merge: 'auto' as const } };
    expect(consultPolicy(pinned, 'merge', 'routine').mode).toBe('auto');
    expect(consultPolicy(pinned, 'merge', 'elevated')).toEqual({
      mode: 'block',
    });
  });
});

describe('describePolicyAuthorization', () => {
  it('a rung authorization names the rung and the stop', () => {
    const ruling = auto(consultPolicy({ rung: 2, gates: {} }, 'scope'));
    expect(describePolicyAuthorization(ruling)).toBe(
      'auto-decided by policy rung 2 (auto-scope)'
    );
  });

  it('an override authorization says so, still carrying the effective rung', () => {
    const ruling = auto(
      consultPolicy(
        { rung: 1, gates: { 'verify-retry': 'auto' } },
        'verify-retry'
      )
    );
    expect(describePolicyAuthorization(ruling)).toBe(
      'auto-decided by a per-gate override (effective rung 1)'
    );
  });
});

describe('the irreversibility floor', () => {
  it('has exactly the six members docs/design/autonomy-ladder.md settles', () => {
    expect(FLOOR_CHECKS).toEqual([
      'force-push',
      'delete-outside-writes',
      'budget-cap',
      'publish',
      'repo-settings',
      'finding-ruling',
    ]);
    for (const def of IRREVERSIBILITY_FLOOR) {
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.summary.length).toBeGreaterThan(0);
    }
  });

  it('is disjoint from the ladder: no floor check is a gate with a rung', () => {
    for (const check of FLOOR_CHECKS) {
      expect(POLICY_GATES).not.toContain(check);
      // GATE_RUNGS has no entry the ladder could lower.
      expect((GATE_RUNGS as Record<string, number>)[check]).toBeUndefined();
    }
    for (const gate of POLICY_GATES) expect(isFloorCheck(gate)).toBe(false);
    expect(isFloorCheck('force-push')).toBe(true);
    expect(isFloorCheck('review')).toBe(false);
  });

  it('blocks every member at the maximum rung, with no policy to consult', () => {
    // consultFloor takes no PolicyConfig: there is nothing a rung 4 project
    // could pass that changes the answer. Every member reads as a floor hold.
    for (const check of FLOOR_CHECKS) {
      expect(consultFloor(check)).toEqual({
        mode: 'block',
        check,
        floor: true,
      });
    }
    // And the ladder's own decision function still demotes every gate at the
    // top rung — the floor is not a fifth gate that happens to sit high.
    for (const gate of POLICY_GATES) {
      expect(
        consultPolicy({ rung: MAX_POLICY_RUNG, gates: {} }, gate).mode
      ).toBe('auto');
    }
  });

  it('phrases a hold receipt with the member label and the always-blocks clause', () => {
    const check: FloorCheck = 'publish';
    expect(describeFloorHold(check)).toBe(
      'held by the irreversibility floor (Publishing artifacts) — always blocks for a human at every policy rung'
    );
  });
});
