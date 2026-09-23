import type { ApiClient } from '@dispatch/client';
import type {
  DispatchConfig,
  LedgerEntry,
  PolicyConfig,
  PolicyGate,
  PolicyGateMode,
} from '@dispatch/core/browser';
import {
  consultPolicy,
  MAX_POLICY_RUNG,
  MIN_POLICY_RUNG,
  POLICY_GATES,
  POLICY_RUNGS,
  projectPolicy,
} from '@dispatch/core/browser';
import { Lock } from 'lucide-react';
import { useEffect, useState } from 'react';

import { relativeTime } from '../../lib/landingView';
import { policyReceipts } from '../../lib/policyReceipts';
import { SettingsGroup, SettingsHint, SettingsRow } from './SettingsGroup';
import { PanelRow } from '@/ui/chrome';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

/** The patch shape the section saves — the `policy` slice of the config
 *  PATCH, where a `null` gate pin clears the override. */
interface PolicyPatch {
  policy?: {
    rung?: number;
    gates?: Partial<Record<PolicyGate, PolicyGateMode | null>>;
  };
}

// What each ladder stop means, phrased for the slider. Cumulative on purpose:
// a rung carries every demotion below it (see GATE_RUNGS in core's policy.ts).
const RUNG_DESCRIPTIONS: Record<number, string> = {
  1: 'Every gate parks on you. Nothing auto-decides.',
  2: 'Scope requests auto-approve and record. Verify retries and merges still block.',
  3: 'Scope and tool approvals auto-decide; a failed verify auto-retries through the fix loop. Merges still block.',
  4: 'Green runs land through the merge queue on their own. You review the receipts.',
};

// One line per gate: what actually happens when it auto-decides, so the table
// reads as behavior, not as config keys.
const GATE_COPY: Record<PolicyGate, { label: string; meaning: string }> = {
  scope: {
    label: 'Scope requests',
    meaning: 'An agent asks to edit outside its declared writes',
  },
  approval: {
    label: 'Tool approvals',
    meaning: 'A tool call the safety classifier referred to a human',
  },
  'verify-retry': {
    label: 'Verify retry',
    meaning: 'A failed verification re-enters the fix loop',
  },
  merge: {
    label: 'Merge',
    meaning: 'A finished green run enters the merge queue',
  },
  wake: {
    label: 'Wake sleeping agents for messages',
    meaning: 'A queued message wakes a sleeping agent to deliver it',
  },
};

// The irreversibility floor, rendered but never configurable. Display copy
// only — enforcement lives server-side and never consults the rung. The six
// members are the settled ladder's (epic e-ad1978 ledger); this list is what
// the UI *promises*, so keep it in step with the server's floor checks.
const FLOOR_ROWS: readonly string[] = [
  'Force-push to refs the run does not own',
  'Deletes outside declared writes',
  'Spend above the budget cap',
  'Publishing artifacts (npm publish, release-tag pushes)',
  'Repo visibility and remote settings changes',
  'Machine rulings on findings that require one',
];

interface AutonomySliderProps {
  rung: number;
  onRungChange: (rung: number) => void;
}

/** The builder lens's whole policy surface: one slider over the ladder's
 *  stops. Fully controlled; `onRungChange` fires once per settled change
 *  (release or stop click), not per drag frame. */
function AutonomySlider({ rung, onRungChange }: AutonomySliderProps) {
  // Local while dragging so a drag across stops saves once, on release.
  const [draft, setDraft] = useState(rung);
  useEffect(() => {
    setDraft(rung);
  }, [rung]);

  const commit = (value: number) => {
    setDraft(value);
    if (value !== rung) onRungChange(value);
  };

  const percent =
    ((draft - MIN_POLICY_RUNG) / (MAX_POLICY_RUNG - MIN_POLICY_RUNG)) * 100;
  const active = POLICY_RUNGS.find((stop) => stop.rung === draft);

  return (
    <div className="flex flex-col gap-2">
      <input
        type="range"
        aria-label="Autonomy"
        min={MIN_POLICY_RUNG}
        max={MAX_POLICY_RUNG}
        step={1}
        value={draft}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={() => commit(draft)}
        onKeyUp={() => commit(draft)}
        style={{
          backgroundImage: `linear-gradient(to right, var(--accent) ${String(percent)}%, var(--border-chip) ${String(percent)}%)`,
        }}
        className="[&::-moz-range-thumb]:bg-card [&::-moz-range-thumb]:shadow-btn [&::-webkit-slider-thumb]:bg-card [&::-webkit-slider-thumb]:shadow-btn h-1.5 w-full cursor-pointer appearance-none rounded-full outline-none [&::-moz-range-thumb]:size-3.5 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full"
      />
      {/* One label per stop, sitting under the stop it names: the first hugs the track's
          left end, the last its right end, the middle ones centre on theirs — a plain
          four-column grid left every label drifting right of its stop. */}
      <div className="flex">
        {POLICY_RUNGS.map((stop, index) => {
          const edge =
            index === 0
              ? 'text-left'
              : index === POLICY_RUNGS.length - 1
                ? 'text-right'
                : 'text-center';
          return (
            <button
              key={stop.rung}
              type="button"
              aria-pressed={stop.rung === draft}
              onClick={() => commit(stop.rung)}
              className={`rounded-control min-w-0 flex-1 px-1 py-0.5 text-[12px] leading-tight transition-colors duration-100 ${edge} ${
                stop.rung === draft
                  ? 'text-foreground font-medium'
                  : 'text-muted-foreground font-book hover:text-(--text-secondary)'
              }`}
            >
              {stop.label}
            </button>
          );
        })}
      </div>
      <SettingsHint>{RUNG_DESCRIPTIONS[draft] ?? active?.label}</SettingsHint>
    </div>
  );
}

interface GateTableProps {
  policy: PolicyConfig;
  onPinGate: (gate: PolicyGate, pin: PolicyGateMode | null) => void;
}

/** The engineer lens's policy surface: every gate as a row — its effective
 *  mode straight from core's `consultPolicy`, and an override pin that wins
 *  over the rung in either direction — with the irreversibility floor below
 *  as fixed, visibly non-configurable rows. */
function GateTable({ policy, onPinGate }: GateTableProps) {
  return (
    <>
      {POLICY_GATES.map((gate) => {
        const ruling = consultPolicy(policy, gate);
        const pin = policy.gates[gate];
        return (
          <SettingsRow
            key={gate}
            title={GATE_COPY[gate].label}
            subtitle={GATE_COPY[gate].meaning}
            control={
              <>
                <span
                  className={`font-book shrink-0 text-[12px] ${
                    ruling.mode === 'auto'
                      ? 'text-state-review'
                      : 'text-muted-foreground'
                  }`}
                >
                  {ruling.mode === 'auto'
                    ? ruling.authorizedBy === 'override'
                      ? 'Auto + records (pinned)'
                      : 'Auto + records'
                    : pin === 'block'
                      ? 'Blocks (pinned)'
                      : 'Blocks'}
                </span>
                <Select
                  value={pin ?? 'rung'}
                  onValueChange={(next) =>
                    onPinGate(
                      gate,
                      next === 'rung' ? null : (next as PolicyGateMode)
                    )
                  }
                >
                  <SelectTrigger
                    aria-label={`${GATE_COPY[gate].label} override`}
                    className="w-[130px]"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="rung">Rung decides</SelectItem>
                    <SelectItem value="block">Always block</SelectItem>
                    <SelectItem value="auto">Always auto</SelectItem>
                  </SelectContent>
                </Select>
              </>
            }
          />
        );
      })}

      <PanelRow className="bg-surface-quaternary text-muted-foreground h-8 min-h-0 gap-2 py-0 text-[12px] font-medium">
        Irreversibility floor
      </PanelRow>
      {FLOOR_ROWS.map((row) => (
        <PanelRow
          key={row}
          aria-disabled="true"
          className="text-muted-foreground min-h-8 flex-nowrap gap-2 py-1 text-[13px]"
        >
          <Lock aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{row}</span>
          <span className="font-book shrink-0 text-[12px]">Always blocks</span>
        </PanelRow>
      ))}
      <PanelRow>
        <SettingsHint>
          The floor does not move with the slider — these block at every rung,
          with no override.
        </SettingsHint>
      </PanelRow>
    </>
  );
}

interface PolicySectionProps {
  config: DispatchConfig;
  onSave: (patch: PolicyPatch) => Promise<void>;
  client: ApiClient | null;
  /** Opens a task's full view, where its ledger holds the complete receipt.
   *  Absent (a shell without navigation), receipts render unlinked. */
  onOpenTask?: (taskId: string) => void;
}

// How many receipts to show inline; the task ledgers hold the full history.
const RECEIPT_LIMIT = 8;

/** Both lenses' policy control over the one per-project config: the builder's
 *  autonomy slider, the engineer's full gate table, and the receipts the
 *  auto-decisions leave behind. Rendered together until the lens field ships
 *  (epic e-3a6884) — the lens shells then pick up `AutonomySlider` and
 *  `GateTable` individually. */
export function PolicySection({
  config,
  onSave,
  client,
  onOpenTask,
}: PolicySectionProps) {
  const policy = projectPolicy(config);

  const [receipts, setReceipts] = useState<LedgerEntry[] | null>(null);
  const [receiptsError, setReceiptsError] = useState(false);
  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    client
      .fetchLedger()
      .then((entries) => {
        if (cancelled) return;
        setReceipts(policyReceipts(entries, RECEIPT_LIMIT));
      })
      .catch(() => {
        if (!cancelled) setReceiptsError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const now = Date.now();

  return (
    <>
      <SettingsGroup title="Autonomy">
        <PanelRow className="flex-col items-stretch gap-1.5 py-3">
          <AutonomySlider
            rung={policy.rung}
            onRungChange={(rung) => void onSave({ policy: { rung } })}
          />
        </PanelRow>
      </SettingsGroup>

      <SettingsGroup
        title="Gate table"
        hint="Per-gate pins win over the rung, in either direction. Every auto-decision still records to the ledger, findings, and evidence."
      >
        <GateTable
          policy={policy}
          onPinGate={(gate, pin) =>
            void onSave({ policy: { gates: { [gate]: pin } } })
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Receipts">
        {receiptsError && (
          <PanelRow>
            <SettingsHint>
              Could not load the ledger for this project.
            </SettingsHint>
          </PanelRow>
        )}
        {!receiptsError && receipts !== null && receipts.length === 0 && (
          <PanelRow>
            <SettingsHint>
              No auto-decisions yet. When a gate auto-decides, its receipt lands
              in the ledger and shows up here.
            </SettingsHint>
          </PanelRow>
        )}
        {!receiptsError &&
          receipts !== null &&
          receipts.map((entry) => {
            const taskId = entry.sourceTaskId;
            const canOpen = onOpenTask !== undefined && taskId !== null;
            return (
              <PanelRow
                key={entry.id}
                onClick={canOpen ? () => onOpenTask(taskId) : undefined}
                className="flex-col items-stretch gap-0.5 py-2"
              >
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                    {entry.title}
                  </span>
                  {entry.sourceTaskId !== null && (
                    <span className="text-muted-foreground font-book shrink-0 text-[12px] tracking-(--id-tracking)">
                      {entry.sourceTaskId}
                    </span>
                  )}
                  <span className="text-muted-foreground font-book shrink-0 text-[12px]">
                    {relativeTime(entry.createdAt, now)}
                  </span>
                </div>
                <p className="text-muted-foreground font-book truncate text-left text-[12px]">
                  {entry.detail}
                </p>
              </PanelRow>
            );
          })}
      </SettingsGroup>
    </>
  );
}
