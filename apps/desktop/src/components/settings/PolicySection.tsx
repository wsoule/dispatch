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
import { HintText, Panel, PanelHeader, PanelRow } from '@/ui/chrome';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';

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
          backgroundImage: `linear-gradient(to right, var(--primary) ${String(percent)}%, var(--surface-inset) ${String(percent)}%)`,
        }}
        className="[&::-moz-range-thumb]:bg-card [&::-moz-range-thumb]:shadow-btn [&::-webkit-slider-thumb]:bg-card [&::-webkit-slider-thumb]:shadow-btn h-1.5 w-full cursor-pointer appearance-none rounded-full outline-none [&::-moz-range-thumb]:size-3.5 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full"
      />
      <div className="grid grid-cols-4 gap-1">
        {POLICY_RUNGS.map((stop) => (
          <button
            key={stop.rung}
            type="button"
            aria-pressed={stop.rung === draft}
            onClick={() => commit(stop.rung)}
            className={`rounded-chip px-1 py-0.5 text-left text-[11px] leading-tight transition-colors ${
              stop.rung === draft
                ? 'text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {stop.label}
          </button>
        ))}
      </div>
      <p className="text-muted-foreground text-[12px]">
        {RUNG_DESCRIPTIONS[draft] ?? active?.label}
      </p>
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
    <div className="flex flex-col">
      {POLICY_GATES.map((gate) => {
        const ruling = consultPolicy(policy, gate);
        const pin = policy.gates[gate];
        return (
          <div
            key={gate}
            className="border-border/60 flex items-center gap-3 border-b py-2 last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">
                {GATE_COPY[gate].label}
              </div>
              <div className="text-muted-foreground text-[11.5px]">
                {GATE_COPY[gate].meaning}
              </div>
            </div>
            <span
              className={`shrink-0 text-[11.5px] ${
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
            <NativeSelect
              size="sm"
              aria-label={`${GATE_COPY[gate].label} override`}
              value={pin ?? 'rung'}
              onChange={(e) => {
                const next = e.target.value;
                onPinGate(
                  gate,
                  next === 'rung' ? null : (next as PolicyGateMode)
                );
              }}
              className="w-32 shrink-0 text-[12px]"
            >
              <NativeSelectOption value="rung">Rung decides</NativeSelectOption>
              <NativeSelectOption value="block">
                Always block
              </NativeSelectOption>
              <NativeSelectOption value="auto">Always auto</NativeSelectOption>
            </NativeSelect>
          </div>
        );
      })}

      <div className="mt-3 flex flex-col gap-1">
        <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          Irreversibility floor
        </span>
        {FLOOR_ROWS.map((row) => (
          <div
            key={row}
            aria-disabled="true"
            className="text-muted-foreground flex items-center gap-2 py-1 text-[12.5px]"
          >
            <Lock aria-hidden className="size-3 shrink-0" />
            <span className="min-w-0 flex-1">{row}</span>
            <span className="shrink-0 text-[11.5px]">Always blocks</span>
          </div>
        ))}
        <HintText className="mt-1">
          The floor does not move with the slider — these block at every rung,
          with no override.
        </HintText>
      </div>
    </div>
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
      <Panel>
        <PanelHeader>Autonomy</PanelHeader>
        <PanelRow className="flex-col items-stretch gap-1.5">
          <AutonomySlider
            rung={policy.rung}
            onRungChange={(rung) => void onSave({ policy: { rung } })}
          />
        </PanelRow>
      </Panel>

      <Panel>
        <PanelHeader>Gate table</PanelHeader>
        <PanelRow className="flex-col items-stretch gap-1.5">
          <HintText>
            Per-gate pins win over the rung, in either direction. Every
            auto-decision still records to the ledger, findings, and evidence.
          </HintText>
          <GateTable
            policy={policy}
            onPinGate={(gate, pin) =>
              void onSave({ policy: { gates: { [gate]: pin } } })
            }
          />
        </PanelRow>
      </Panel>

      <Panel>
        <PanelHeader>Receipts</PanelHeader>
        <PanelRow className="flex-col items-stretch gap-1.5">
          {receiptsError && (
            <HintText>Could not load the ledger for this project.</HintText>
          )}
          {!receiptsError && receipts !== null && receipts.length === 0 && (
            <HintText>
              No auto-decisions yet. When a gate auto-decides, its receipt lands
              in the ledger and shows up here.
            </HintText>
          )}
          {!receiptsError && receipts !== null && receipts.length > 0 && (
            <ul className="flex flex-col">
              {receipts.map((entry) => {
                const body = (
                  <>
                    <div className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
                        {entry.title}
                      </span>
                      {entry.sourceTaskId !== null && (
                        <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
                          {entry.sourceTaskId}
                        </span>
                      )}
                      <span className="text-muted-foreground shrink-0 text-[11px]">
                        {relativeTime(entry.createdAt, now)}
                      </span>
                    </div>
                    <p className="text-muted-foreground truncate text-left text-[11.5px]">
                      {entry.detail}
                    </p>
                  </>
                );
                const taskId = entry.sourceTaskId;
                const canOpen = onOpenTask !== undefined && taskId !== null;
                return (
                  <li
                    key={entry.id}
                    className="border-border/60 border-b py-1.5 last:border-b-0"
                  >
                    {canOpen ? (
                      <button
                        type="button"
                        onClick={() => onOpenTask(taskId)}
                        className="hover:bg-surface-inset/60 -mx-1 block w-[calc(100%+0.5rem)] rounded-sm px-1 text-left"
                      >
                        {body}
                      </button>
                    ) : (
                      body
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </PanelRow>
      </Panel>
    </>
  );
}
