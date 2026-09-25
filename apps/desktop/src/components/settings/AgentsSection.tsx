import type { ExecutorsResponse } from '@dispatch/client';
import type {
  ConfigPatch,
  DispatchConfig,
  EffortConfig,
  ModelConfig,
} from '@dispatch/core/browser';
import { EFFORT_ROLES, MODEL_ROLES } from '@dispatch/core/browser';

import {
  DEFAULT_EFFORT_ID,
  effortFromId,
  effortOptions,
  modelDisplayName,
  MODELS,
} from '../../lib/models';
import { CliAgents } from './AgentsMoreGroups';
import { ChoiceSetting, NumberSetting } from './fields';
import { SettingsGroup, SettingsHint, SettingsRow } from './SettingsGroup';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

interface AgentsSectionProps {
  config: DispatchConfig;
  executors: ExecutorsResponse | null;
  onSave: (patch: ConfigPatch) => Promise<unknown>;
  canOperate: boolean;
}

// One row per config.models role, in plain words: what the work is, not the
// role's config key. The key stays searchable through `keywords`.
const ROLE_INFO: Record<keyof ModelConfig, { label: string; hint: string }> = {
  execute: { label: 'Coding runs', hint: 'Agents that change your code.' },
  overseer: {
    label: 'Assistant',
    hint: 'The chat that watches your project and can act on it.',
  },
  plan: {
    label: 'Planning',
    hint: 'Conversations that turn an idea into tasks.',
  },
  draft: { label: 'Task drafting', hint: 'Turning a sentence into a task.' },
  enrich: {
    label: 'Filling in details',
    hint: 'Writing descriptions and acceptance criteria.',
  },
  cluster: {
    label: 'Inbox grouping',
    hint: 'Grouping inbox notes into suggested epics.',
  },
  summarize: {
    label: 'Summaries',
    hint: 'Titles, summaries and commit messages.',
  },
  judge: {
    label: 'Judgments',
    hint: 'Quick yes/no calls such as triage and readiness.',
  },
};

// `judge` names a TypeSafe model, which the Claude picker cannot offer; it is
// set in config.yml until a TypeSafe model list exists.
const PICKABLE_ROLES = MODEL_ROLES.filter((role) => role !== 'judge');

function hasEffort(role: keyof ModelConfig): role is keyof EffortConfig {
  return (EFFORT_ROLES as readonly string[]).includes(role);
}

// The picker's choices for a role: every dispatchable model, plus the role's
// current model when it is an older one no longer offered, so the select
// names it instead of going blank.
function modelChoices(current: string): { id: string; label: string }[] {
  if (MODELS.some((m) => m.id === current)) return MODELS;
  return [
    ...MODELS,
    { id: current, label: modelDisplayName(current) ?? current },
  ];
}

// Four of the six modes config.ts accepts; `plan` and `bypassPermissions`
// fall through to the note under the radios instead.
const PERMISSION_MODES = [
  ['auto', "Let Dispatch's safety check decide (recommended)"],
  ['default', 'Ask me every time'],
  ['acceptEdits', 'Allow file edits, ask for everything else'],
  ['dontAsk', 'Never ask'],
] as const;

const OFFERED_MODES: readonly string[] = PERMISSION_MODES.map(([mode]) => mode);

/** Settings → Agents: models and effort per kind of work, the limits runs
 *  work under, what they may do unasked, and the agents a dispatch can use.
 *  Save feedback lives in the shell, not here: this only calls `onSave`. */
export function AgentsSection({
  config,
  executors,
  onSave,
  canOperate,
}: AgentsSectionProps) {
  const agentNames = [
    ...new Set([
      ...(executors?.executors.map((e) => e.name) ?? []),
      ...Object.keys(config.executors ?? {}),
      config.orchestrator.executor,
    ]),
  ];
  return (
    <>
      <SettingsGroup
        title="Models"
        hint="The model and effort for each kind of work. Higher effort thinks longer and costs more; Default lets the model decide."
        keywords="thinking reasoning"
      >
        {PICKABLE_ROLES.map((role) => {
          const info = ROLE_INFO[role];
          const current = config.models[role];
          return (
            <SettingsRow
              key={role}
              title={info.label}
              subtitle={info.hint}
              keywords={`${role} model ${hasEffort(role) ? 'effort' : ''}`}
              control={
                <>
                  <Select
                    value={current}
                    onValueChange={(id) =>
                      void onSave({ models: { [role]: id } })
                    }
                  >
                    <SelectTrigger
                      aria-label={`${info.label} model`}
                      className="w-[124px]"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {modelChoices(current).map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {hasEffort(role) ? (
                    <Select
                      value={config.effort?.[role] ?? DEFAULT_EFFORT_ID}
                      onValueChange={(id) =>
                        void onSave({
                          effort: { [role]: effortFromId(id) ?? null },
                        })
                      }
                    >
                      <SelectTrigger
                        aria-label={`${info.label} effort`}
                        className="w-[112px]"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {effortOptions(undefined).map((o) => (
                          <SelectItem key={o.id} value={o.id}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    // Holds the column so every model select lines up.
                    <span aria-hidden className="w-[112px]" />
                  )}
                </>
              }
            />
          );
        })}
      </SettingsGroup>

      <SettingsGroup title="Limits" keywords="caps">
        <NumberSetting
          id="max-concurrency"
          title="Runs at once"
          subtitle="The most agents working on this project at the same time."
          keywords="concurrency parallel"
          value={config.orchestrator.maxConcurrency}
          onSave={(n) => n !== null && void onSave({ maxConcurrency: n })}
        />
        <NumberSetting
          id="epic-concurrency"
          title="Runs at once per epic"
          subtitle="How many of an epic's tasks start together when you dispatch it."
          keywords="concurrency parallel"
          value={config.orchestrator.epicConcurrency}
          onSave={(n) => n !== null && void onSave({ epicConcurrency: n })}
        />
        <NumberSetting
          id="turn-cap"
          title="Turns per run"
          subtitle="Stops a run after this many turns. Leave empty for no limit."
          keywords="cap maxTurns"
          value={config.orchestrator.maxTurns}
          placeholder="No limit"
          allowEmpty
          onSave={(maxTurns) => void onSave({ maxTurns })}
        />
        <NumberSetting
          id="budget-cap-per-run"
          title="Spend per run"
          subtitle="Stops a run once it has spent this much. Leave empty for no limit."
          keywords="budget cap cost dollars maxBudgetUsd"
          value={config.orchestrator.maxBudgetUsd}
          min={0.01}
          integer={false}
          suffix="USD"
          placeholder="No limit"
          allowEmpty
          onSave={(maxBudgetUsd) => void onSave({ maxBudgetUsd })}
        />
        <NumberSetting
          id="run-cost-estimate"
          title="Expected cost per run"
          subtitle="Used to plan spend before a run reports what it actually cost."
          keywords="budget estimate"
          value={config.orchestrator.runCostEstimateUsd}
          min={0.01}
          integer={false}
          suffix="USD"
          onSave={(n) => n !== null && void onSave({ runCostEstimateUsd: n })}
        />
      </SettingsGroup>

      <SettingsGroup
        title="Permissions"
        keywords="approval permission mode classifier"
      >
        <SettingsRow
          title="When an agent wants to run a command or edit a file"
          subtitle="Applies to every run and to the assistant."
          keywords="approve tools bash"
          stacked
        >
          {/* Native radios: a real input keeps `getByLabelText(...).checked`
              meaningful in the tests. */}
          <div
            role="radiogroup"
            aria-label="When an agent wants to run a command or edit a file"
            className="grid gap-1.5"
          >
            {PERMISSION_MODES.map(([mode, label]) => (
              <label
                key={mode}
                className="font-book flex items-center gap-2 text-[13px] text-(--text-secondary)"
              >
                <input
                  type="radio"
                  name="permission-mode"
                  value={mode}
                  checked={config.orchestrator.permissionMode === mode}
                  onChange={() => void onSave({ permissionMode: mode })}
                  className="accent-primary size-3.5"
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          {!OFFERED_MODES.includes(config.orchestrator.permissionMode) && (
            <SettingsHint>
              Currently &ldquo;{config.orchestrator.permissionMode}&rdquo;, set
              by hand in .dispatch/config.yml.
            </SettingsHint>
          )}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Defaults">
        <ChoiceSetting
          id="default-executor"
          title="Default agent"
          subtitle="Used when a dispatch doesn't pick one."
          keywords="executor"
          value={config.orchestrator.executor}
          choices={agentNames.map((name) => ({ value: name, label: name }))}
          onSave={(executor) => void onSave({ executor })}
        />
      </SettingsGroup>

      <CliAgents config={config} onSave={onSave} canOperate={canOperate} />
    </>
  );
}
