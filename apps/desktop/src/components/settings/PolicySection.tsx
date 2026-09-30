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
import { SettingsSearchable } from './search';
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
  1: 'Every decision waits for you.',
  2: 'Requests to edit extra files are approved for you. Everything else waits.',
  3: 'Extra files and uncertain commands are decided for you, and failed checks go straight back to be fixed. Merging, shared memory and accepted docs still wait.',
  4: "Work that passes its checks merges on its own. You review what happened afterwards. Agents' lessons join shared memory without review. Agents' edits to accepted docs apply without review.",
};

// Short names for the slider's stops, in the page's words rather than core's.
const RUNG_LABELS: Record<number, string> = {
  1: 'Review everything',
  2: 'Allow extra files',
  3: 'Fix on its own',
  4: 'Merge and accept memory and doc edits on their own',
};

// One line per gate: what actually happens when it auto-decides, so the table
// reads as behavior, not as config keys.
const GATE_COPY: Record<PolicyGate, { label: string; meaning: string }> = {
  scope: {
    label: 'Extra files',
    meaning: 'An agent asks to edit files outside its task.',
  },
  approval: {
    label: 'Uncertain commands',
    meaning: "A command the safety check wasn't sure about.",
  },
  'verify-retry': {
    label: 'Retrying failed checks',
    meaning: 'Work that failed its checks goes back to be fixed.',
  },
  merge: {
    label: 'Merging',
    meaning: 'Finished work that passed its checks joins the merge queue.',
  },
  wake: {
    label: 'Waking agents for messages',
    meaning: 'A queued message wakes a sleeping agent to deliver it.',
  },
  memory: {
    label: 'Shared memory from agents',
    meaning:
      "An agent's lesson joins the memory every run here, and every teammate's run, reads.",
  },
  doc: {
    label: 'Edits to accepted docs',
    meaning:
      "An agent's edit to an accepted team doc applies without review, and every run that links the doc reads it.",
  },
};

// The irreversibility floor, rendered but never configurable. Display copy
// only — enforcement lives server-side and never consults the rung. The six
// members are the settled ladder's (epic e-ad1978 ledger); this list is what
// the UI *promises*, so keep it in step with the server's floor checks.
const FLOOR_ROWS: readonly { text: string; keywords: string }[] = [
  { text: "Force-pushing over a branch the run doesn't own", keywords: 'git' },
  { text: 'Deleting files outside the task', keywords: 'delete' },
  { text: 'Spending past the per-run limit', keywords: 'budget cost cap' },
  {
    text: 'Publishing packages or pushing release tags',
    keywords: 'npm release',
  },
  { text: 'Changing repo visibility or remote settings', keywords: 'github' },
  {
    text: 'A machine settling a finding that needs a person',
    keywords: 'review',
  },
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
              {RUNG_LABELS[stop.rung] ?? stop.label}
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
                      ? 'Automatic, pinned'
                      : 'Automatic'
                    : pin === 'block'
                      ? 'Waits, pinned'
                      : 'Waits for you'}
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
                    className="w-[140px]"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="rung">Follow level</SelectItem>
                    <SelectItem value="block">Always wait</SelectItem>
                    <SelectItem value="auto">Always automatic</SelectItem>
                  </SelectContent>
                </Select>
              </>
            }
          />
        );
      })}
    </>
  );
}

/** The hard stops: never configurable, shown so the promise is visible. */
function HardStops() {
  return (
    <>
      {FLOOR_ROWS.map((row) => (
        <SettingsSearchable
          key={row.text}
          text={`${row.text} ${row.keywords} hard stop floor`}
        >
          <PanelRow
            aria-disabled="true"
            className="text-muted-foreground min-h-9 flex-nowrap gap-2 py-1 text-[13px]"
          >
            <Lock aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{row.text}</span>
            <span className="font-book shrink-0 text-[12px]">Always waits</span>
          </PanelRow>
        </SettingsSearchable>
      ))}
    </>
  );
}

interface PolicySectionProps {
  config: DispatchConfig;
  onSave: (patch: PolicyPatch) => Promise<unknown>;
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
      .fetchLedger({ class: 'audit' })
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
      <SettingsGroup
        title="Level"
        hint="Every automatic decision is recorded, and the recent ones are listed below."
        keywords="autonomy policy rung slider"
      >
        <SettingsSearchable text="autonomy level review everything merge on its own">
          <PanelRow className="flex-col items-stretch gap-1.5 py-3">
            <AutonomySlider
              rung={policy.rung}
              onRungChange={(rung) => void onSave({ policy: { rung } })}
            />
          </PanelRow>
        </SettingsSearchable>
      </SettingsGroup>

      <SettingsGroup
        title="Overrides"
        hint="Make one kind of decision always wait for you, or always go ahead, whatever the level."
        keywords="gate table pin"
      >
        <GateTable
          policy={policy}
          onPinGate={(gate, pin) =>
            void onSave({ policy: { gates: { [gate]: pin } } })
          }
        />
      </SettingsGroup>

      <SettingsGroup
        title="Hard stops"
        requires="none"
        hint="These always wait for you, at every level. They can't be overridden."
        keywords="irreversibility floor"
      >
        <HardStops />
      </SettingsGroup>

      <SettingsGroup
        title="Recent automatic decisions"
        requires="none"
        keywords="receipts ledger"
      >
        {receiptsError && (
          <PanelRow>
            <SettingsHint>Couldn&rsquo;t load recent decisions.</SettingsHint>
          </PanelRow>
        )}
        {!receiptsError && receipts !== null && receipts.length === 0 && (
          <PanelRow>
            <SettingsHint>
              None yet. Each one is listed here and recorded on its task.
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
