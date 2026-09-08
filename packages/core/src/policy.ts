// Pure data shapes, no node:* imports, so this is safe for the desktop
// webview via the '@dispatch/core/browser' entry point.
//
// The policy engine: per-project autonomy config deciding which gates still
// block on a human and which auto-decide and record. The ladder, the
// rung-to-gate assignments and the per-task risk caps are data tables, not
// control flow, so the settled design (docs/design/autonomy-ladder.md) lands
// as table edits and every call site picks them up through consultPolicy.

import type { TaskRisk } from './types.js';

/** A human gate the policy engine can demote from blocking to recording. */
export type PolicyGate = 'scope' | 'approval' | 'verify-retry' | 'merge';

/** Runtime counterpart of PolicyGate — see the note on FINDING_SEVERITIES. */
export const POLICY_GATES: readonly PolicyGate[] = [
  'scope',
  'approval',
  'verify-retry',
  'merge',
];

/**
 * One stop of the autonomy ladder. Rungs are ordered: a project at rung N has
 * every demotion of the rungs at or below N. Rung 1 is today's strictest
 * behavior — every gate blocks.
 */
export interface PolicyRungDef {
  rung: number;
  name: string;
  /** What the stop means, phrased for the slider UI. */
  label: string;
}

/** The ladder's stops, per docs/design/autonomy-ladder.md. */
export const POLICY_RUNGS: readonly PolicyRungDef[] = [
  { rung: 1, name: 'review-all', label: 'Review everything' },
  { rung: 2, name: 'auto-scope', label: 'Auto-accept scope requests' },
  {
    rung: 3,
    name: 'auto-verify',
    label: 'Auto-review, fix and retry verification',
  },
  { rung: 4, name: 'auto-merge', label: 'Auto-merge on green' },
];

export const MIN_POLICY_RUNG = 1;
export const MAX_POLICY_RUNG = 4;

/**
 * The rung at which each gate stops blocking and starts recording. THE
 * assignment table: the settled design adjusts autonomy by editing these
 * numbers, and every call site picks the change up through consultPolicy.
 *
 * - scope: an agent's request to edit outside its declared writes.
 * - approval: a tool-call escalation the SDK classifier referred to a human.
 * - verify-retry: igniting the review→fix loop and re-running a red verify.
 * - merge: handing a green run to the merge queue.
 */
export const GATE_RUNGS: Record<PolicyGate, number> = {
  scope: 2,
  approval: 3,
  'verify-retry': 3,
  merge: 4,
};

/**
 * The highest rung a task's declared risk allows, whatever the project says.
 * `effectiveRung = min(project rung, cap)`: a human always merges elevated
 * work, and a critical task (a publish, a release) never auto-decides at all.
 * A per-gate `auto` pin does not beat the cap — the cap is the task saying
 * "watch this one", and a project-wide pin cannot know which task it is on.
 */
export const RISK_RUNG_CAPS: Record<TaskRisk, number> = {
  routine: 4,
  elevated: 3,
  critical: 1,
};

/** A per-gate override pin: `block` re-promotes a gate the rung would demote,
 *  `auto` demotes one gate without raising the whole rung. */
export type PolicyGateMode = 'block' | 'auto';

export const POLICY_GATE_MODES: readonly PolicyGateMode[] = ['block', 'auto'];

export interface PolicyConfig {
  /** The project's ladder stop. Defaults to 1: nothing auto-decides until a
   *  human raises the rung. */
  rung: number;
  /** Per-gate pins that win over the rung, in either direction. */
  gates: Partial<Record<PolicyGate, PolicyGateMode>>;
}

export const DEFAULT_POLICY: PolicyConfig = { rung: 1, gates: {} };

/**
 * What a gate call site should do, and — when it may auto-decide — the
 * authorization it must write into the ledger entry recording the decision.
 */
export type PolicyRuling =
  | { mode: 'block' }
  | {
      mode: 'auto';
      gate: PolicyGate;
      /** The rung in force when the gate consulted policy: the project rung,
       *  lowered to the task's risk cap when that is lower. */
      rung: number;
      /** Whether the rung itself or a per-gate pin authorized the demotion. */
      authorizedBy: 'rung' | 'override';
    };

/** The rung a task actually runs at: the project rung, capped by the task's
 *  risk. Absent risk reads as routine, the cap that changes nothing. */
export function effectiveRung(policy: PolicyConfig, risk?: TaskRisk): number {
  return Math.min(policy.rung, RISK_RUNG_CAPS[risk ?? 'routine']);
}

/**
 * The single decision function every gate call site consults. A gate below
 * the effective rung (and not pinned `auto`) blocks exactly as today; at or
 * above it, the caller auto-decides and records the returned authorization.
 * `risk` is the task's declared risk, which caps the rung — see RISK_RUNG_CAPS.
 */
export function consultPolicy(
  policy: PolicyConfig,
  gate: PolicyGate,
  risk?: TaskRisk
): PolicyRuling {
  const rung = effectiveRung(policy, risk);
  // The risk cap is checked ahead of the pins: it bounds what any project-wide
  // setting may do to this particular task.
  if (RISK_RUNG_CAPS[risk ?? 'routine'] < GATE_RUNGS[gate]) {
    return { mode: 'block' };
  }
  const pinned = policy.gates[gate];
  if (pinned === 'block') return { mode: 'block' };
  if (pinned === 'auto') {
    return { mode: 'auto', gate, rung, authorizedBy: 'override' };
  }
  if (rung >= GATE_RUNGS[gate]) {
    return { mode: 'auto', gate, rung, authorizedBy: 'rung' };
  }
  return { mode: 'block' };
}

/**
 * The irreversibility floor: actions that always block for a human, at every
 * policy rung, in both lenses. Deliberately a DIFFERENT type from PolicyGate —
 * consultPolicy cannot be asked about a floor check, GATE_RUNGS has no entry
 * to lower, and PolicyConfig.gates cannot pin one — so the policy engine
 * cannot demote the floor by construction, not by convention.
 *
 * Membership is the six members docs/design/autonomy-ladder.md settles
 * (t-df1163, "The irreversibility floor"). Amending the floor is an edit to
 * this table, and only this table: the server's detectors (server/floor.ts)
 * and both lenses key off it.
 */
export type FloorCheck =
  | 'force-push'
  | 'delete-outside-writes'
  | 'budget-cap'
  | 'publish'
  | 'repo-settings'
  | 'finding-ruling';

/** One floor member, with the copy both lenses render: the builder slider's
 *  always-on footer and the engineer gate table's pinned rows show the same
 *  label and summary. */
export interface FloorCheckDef {
  check: FloorCheck;
  label: string;
  summary: string;
}

export const IRREVERSIBILITY_FLOOR: readonly FloorCheckDef[] = [
  {
    check: 'force-push',
    label: 'Force-push',
    summary:
      'Rewriting a pushed ref the run does not own destroys commits others may hold.',
  },
  {
    check: 'delete-outside-writes',
    label: 'Deletes outside declared writes',
    summary:
      'A file or ref deleted beyond the task’s declared fence never lands unreviewed.',
  },
  {
    check: 'budget-cap',
    label: 'Spend above the budget cap',
    summary:
      'A run that hit its cost cap needs a human before anything spends more; no rung raises the cap.',
  },
  {
    check: 'publish',
    label: 'Publishing artifacts',
    summary:
      'A published package or a pushed release tag is public and cannot be recalled.',
  },
  {
    check: 'repo-settings',
    label: 'Repository visibility and remote settings',
    summary:
      'Changing visibility or the default branch, or deleting a remote repo, exposes or loses history irreversibly.',
  },
  {
    check: 'finding-ruling',
    label: 'Rulings on blocking findings',
    summary:
      'A critical or blocking finding, or a capped fix loop, waits for a written human ruling.',
  },
];

/** Runtime counterpart of FloorCheck, same pattern as POLICY_GATES. */
export const FLOOR_CHECKS: readonly FloorCheck[] = IRREVERSIBILITY_FLOOR.map(
  (def) => def.check
);

/** Membership test against unvalidated input (config keys, API payloads). */
export function isFloorCheck(value: string): value is FloorCheck {
  return FLOOR_CHECKS.includes(value as FloorCheck);
}

/**
 * The floor's whole decision function: it takes no PolicyConfig on purpose.
 * There is no rung, pin, or lens that changes the answer — the return type
 * cannot even express 'auto'.
 */
export interface FloorRuling {
  mode: 'block';
  check: FloorCheck;
  /** Marks the ruling as a floor hold, so surfaces can render the padlock. */
  floor: true;
}

export function consultFloor(check: FloorCheck): FloorRuling {
  return { mode: 'block', check, floor: true };
}

/** The one-line receipt a floor hold carries, mirroring
 *  describePolicyAuthorization so ledger entries phrase both directions of the
 *  policy engine identically. */
export function describeFloorHold(check: FloorCheck): string {
  const def = IRREVERSIBILITY_FLOOR.find((d) => d.check === check);
  return `held by the irreversibility floor (${def?.label ?? check}) — always blocks for a human at every policy rung`;
}

/**
 * The one-line provenance a recorded auto-decision carries in the ledger, so
 * every gate phrases its authorization identically and the receipt names the
 * exact rung that permitted it.
 */
export function describePolicyAuthorization(
  ruling: Extract<PolicyRuling, { mode: 'auto' }>
): string {
  const stop = POLICY_RUNGS.find((r) => r.rung === GATE_RUNGS[ruling.gate]);
  const source =
    ruling.authorizedBy === 'override'
      ? `a per-gate override (effective rung ${ruling.rung})`
      : `policy rung ${ruling.rung} (${stop?.name ?? ruling.gate})`;
  return `auto-decided by ${source}`;
}
