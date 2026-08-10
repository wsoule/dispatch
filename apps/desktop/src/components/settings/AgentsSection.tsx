import type {
  DispatchConfig,
  EscalationStep,
  ModelConfig,
} from '@dispatch/core/browser';
import { MODEL_ROLES } from '@dispatch/core/browser';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import { useEffect, useState } from 'react';

import { MODELS } from '../../lib/models';
import { EscalationEditor } from './EscalationEditor';
import { HintText, Panel, PanelHeader, PanelRow } from '@/ui/chrome';
import { Field, FieldDescription, FieldLabel } from '@/ui/field';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { RadioGroup } from '@/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

interface AgentsSectionProps {
  config: DispatchConfig;
  onSave: (patch: {
    epicConcurrency?: number;
    permissionMode?: string;
    models?: Partial<ModelConfig>;
    maxTurns?: number | null;
    maxBudgetUsd?: number | null;
    fixLoop?: { cap?: number; escalation?: EscalationStep[] };
  }) => Promise<void>;
}

// One row per config.models role, mirroring ModelConfig's doc comments in
// packages/core/src/config.ts so the schema doesn't have to be read.
const ROLE_INFO: Record<keyof ModelConfig, { label: string; hint: string }> = {
  execute: { label: 'Coding runs', hint: 'The agent that edits the repo.' },
  plan: { label: 'Planning', hint: 'Multi-turn planning conversations.' },
  draft: {
    label: 'Task drafting',
    hint: 'One-shot natural-language task drafting.',
  },
  enrich: {
    label: 'Enrichment',
    hint: 'Filling in description / acceptance criteria for a task or inbox item.',
  },
  cluster: {
    label: 'Inbox clustering',
    hint: 'Grouping inbox captures into suggested epics.',
  },
  summarize: {
    label: 'Summaries',
    hint: 'Short mechanical text: titles, summaries, commit messages.',
  },
};

// Four of the six modes config.ts accepts; `plan` and `bypassPermissions`
// fall through to the escape-hatch line below instead of a radio.
const PERMISSION_MODES = [
  ['auto', 'Let the classifier decide (default)'],
  ['default', 'Always ask me first'],
  ['acceptEdits', 'Let it edit files, ask before anything else'],
  ['dontAsk', 'Never ask — let it run'],
] as const;

const OFFERED_MODES: readonly string[] = PERMISSION_MODES.map(([mode]) => mode);

// Reads a cap field as the string an input shows: absent stays empty rather
// than rendering the literal word "undefined".
function capToInput(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

/** How agents run: models, concurrency, permission mode, turn/budget caps.
 *  Save feedback lives in the shell, not here — this only calls `onSave`. */
export function AgentsSection({ config, onSave }: AgentsSectionProps) {
  const [concurrency, setConcurrency] = useState('3');
  const [maxTurns, setMaxTurns] = useState('');
  const [maxBudgetUsd, setMaxBudgetUsd] = useState('');
  const [fixLoopCap, setFixLoopCap] = useState('5');

  // Re-seeds when config changes underneath (another window, a hand edit) —
  // keyed on config values, so a field mid-edit isn't clobbered every render.
  useEffect(() => {
    setConcurrency(String(config.orchestrator.epicConcurrency));
    setMaxTurns(capToInput(config.orchestrator.maxTurns));
    setMaxBudgetUsd(capToInput(config.orchestrator.maxBudgetUsd));
    setFixLoopCap(String(config.fixLoop.cap));
  }, [config]);

  // Optional-valued, unlike every other numeric field here: empty clears via
  // null, a finite positive number saves, anything else snaps back.
  function saveCap(
    key: 'maxTurns' | 'maxBudgetUsd',
    raw: string,
    current: number | undefined,
    setDraft: (value: string) => void
  ) {
    const trimmed = raw.trim();
    if (trimmed === '') {
      if (current !== undefined) void onSave({ [key]: null });
      return;
    }
    const n = Number(trimmed);
    if (Number.isFinite(n) && n > 0) {
      if (n !== current) void onSave({ [key]: n });
    } else {
      setDraft(capToInput(current));
    }
  }

  return (
    <Panel>
      <PanelHeader>How agents run</PanelHeader>

      {MODEL_ROLES.map((role) => {
        const info = ROLE_INFO[role];
        return (
          <PanelRow key={role}>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-[13px] font-medium">{info.label}</span>
              <HintText>{info.hint}</HintText>
            </div>
            <Select
              value={config.models[role]}
              onValueChange={(id) => void onSave({ models: { [role]: id } })}
            >
              <SelectTrigger
                size="sm"
                aria-label={`${info.label} model`}
                className="w-[168px] shrink-0 text-[12px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODELS.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </PanelRow>
        );
      })}

      <PanelRow className="flex-col items-stretch gap-1.5">
        <Field className="gap-1.5 [&>*]:w-auto">
          <FieldLabel
            htmlFor="how-many-run-at-once-when-you-dispatch-an-epic"
            className="text-[12px] font-normal"
          >
            How many run at once when you dispatch an epic
          </FieldLabel>
          <Input
            id="how-many-run-at-once-when-you-dispatch-an-epic"
            value={concurrency}
            onChange={(e) => setConcurrency(e.target.value)}
            onBlur={() => {
              const n = Number(concurrency);
              if (
                Number.isInteger(n) &&
                n >= 1 &&
                n !== config.orchestrator.epicConcurrency
              ) {
                void onSave({ epicConcurrency: n });
              } else {
                setConcurrency(String(config.orchestrator.epicConcurrency));
              }
            }}
            inputMode="numeric"
            className="w-20 font-mono text-[12.5px]"
          />
        </Field>
      </PanelRow>

      <PanelRow className="flex-col items-stretch gap-1.5">
        <span className="text-[12px]">
          When an agent wants to do something consequential
        </span>
        <RadioGroup
          value={config.orchestrator.permissionMode}
          onValueChange={(next) => void onSave({ permissionMode: next })}
          className="gap-1.5"
        >
          {PERMISSION_MODES.map(([mode, label]) => (
            <Label key={mode} className="flex items-center gap-2 font-normal">
              {/* asChild swaps Radix's button for a real input so
                  getByLabelText/.checked keep working. */}
              <RadioGroupPrimitive.Item asChild value={mode}>
                <input
                  type="radio"
                  checked={config.orchestrator.permissionMode === mode}
                  readOnly
                  className="accent-accent size-3.5"
                />
              </RadioGroupPrimitive.Item>
              <span className="text-[13px]">{label}</span>
            </Label>
          ))}
        </RadioGroup>
        <HintText>
          Auto lets the SDK&rsquo;s own classifier approve every tool, so a
          dispatched agent proceeds unattended instead of stalling on the first
          Bash call.
        </HintText>
        {!OFFERED_MODES.includes(config.orchestrator.permissionMode) && (
          <span className="dense-meta">
            currently &ldquo;{config.orchestrator.permissionMode}&rdquo;, set in
            .dispatch/config.yml
          </span>
        )}
      </PanelRow>

      <PanelRow className="flex-col items-stretch gap-1.5">
        <Field className="gap-1.5 [&>*]:w-auto">
          <FieldLabel htmlFor="turn-cap" className="text-[12px] font-normal">
            Turn cap
          </FieldLabel>
          <Input
            id="turn-cap"
            value={maxTurns}
            onChange={(e) => setMaxTurns(e.target.value)}
            onBlur={() =>
              saveCap(
                'maxTurns',
                maxTurns,
                config.orchestrator.maxTurns,
                setMaxTurns
              )
            }
            inputMode="numeric"
            placeholder="No cap"
            className="w-24 font-mono text-[12.5px]"
          />
          <FieldDescription className="text-[11px]">
            Ceiling on turns for one run. Leave empty for no cap.
          </FieldDescription>
        </Field>
      </PanelRow>

      <PanelRow className="flex-col items-stretch gap-1.5">
        <Field className="gap-1.5 [&>*]:w-auto">
          <FieldLabel
            htmlFor="budget-cap-per-run"
            className="text-[12px] font-normal"
          >
            Budget cap per run
          </FieldLabel>
          <Input
            id="budget-cap-per-run"
            value={maxBudgetUsd}
            onChange={(e) => setMaxBudgetUsd(e.target.value)}
            onBlur={() =>
              saveCap(
                'maxBudgetUsd',
                maxBudgetUsd,
                config.orchestrator.maxBudgetUsd,
                setMaxBudgetUsd
              )
            }
            inputMode="decimal"
            placeholder="No cap"
            className="w-24 font-mono text-[12.5px]"
          />
          <FieldDescription className="text-[11px]">
            Dollar ceiling on one run&rsquo;s spend. Leave empty for no cap.
          </FieldDescription>
        </Field>
      </PanelRow>

      <PanelRow className="flex-col items-stretch gap-1.5">
        <Field className="gap-1.5 [&>*]:w-auto">
          <FieldLabel
            htmlFor="fix-loop-round-cap"
            className="text-[12px] font-normal"
          >
            Fix-loop round cap
          </FieldLabel>
          <Input
            id="fix-loop-round-cap"
            value={fixLoopCap}
            onChange={(e) => setFixLoopCap(e.target.value)}
            onBlur={() => {
              const n = Number(fixLoopCap);
              if (Number.isInteger(n) && n >= 1 && n !== config.fixLoop.cap) {
                void onSave({ fixLoop: { cap: n } });
              } else {
                setFixLoopCap(String(config.fixLoop.cap));
              }
            }}
            inputMode="numeric"
            className="w-20 font-mono text-[12.5px]"
          />
          <FieldDescription className="text-[11px]">
            Last round the fix loop may dispatch before demanding a ruling.
          </FieldDescription>
        </Field>
      </PanelRow>

      <div className="p-3">
        <EscalationEditor
          steps={config.fixLoop.escalation}
          onChange={(escalation) => void onSave({ fixLoop: { escalation } })}
        />
      </div>
    </Panel>
  );
}
