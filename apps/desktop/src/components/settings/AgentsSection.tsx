import type {
  ConfigPatch,
  DispatchConfig,
  EffortConfig,
  ModelConfig,
  OverseerAutonomy,
  OverseerStreamMode,
  RunStreamMode,
} from '@dispatch-foo/core/browser';
import {
  EFFORT_ROLES,
  MODEL_ROLES,
  overseerAutonomy,
  overseerSettings,
  runSettings,
} from '@dispatch-foo/core/browser';
import type { ApiClient, ExecutorsResponse } from '@dispatch/client';
import { RadioGroup, Select } from '@dispatch/ui';

import {
  DEFAULT_EFFORT_ID,
  effortFromId,
  effortOptions,
  modelDisplayName,
  MODELS,
} from '../../lib/models';
import { CliAgents } from './AgentsMoreGroups';
import styles from './AgentsSection.module.css';
import {
  ChoiceSetting,
  ModeSetting,
  NumberSetting,
  SwitchSetting,
} from './fields';
import { JudgmentStatusRow } from './JudgmentStatusRow';
import { SettingsGroup, SettingsHint, SettingsRow } from './SettingsGroup';

// The overseer's autonomy levels, each saying what it asks about. Cancelling
// or discarding a run and sending as you always ask, whichever is picked.
const AUTONOMY_CHOICES: { value: OverseerAutonomy; label: string }[] = [
  { value: 'cautious', label: 'Cautious: ask about everything' },
  { value: 'balanced', label: 'Balanced: ask once per conversation' },
  { value: 'trusting', label: 'Trusting: only ask about risky actions' },
];

interface AgentsSectionProps {
  config: DispatchConfig;
  executors: ExecutorsResponse | null;
  onSave: (patch: ConfigPatch) => Promise<unknown>;
  canOperate: boolean;
  /** For Jev's status line; without a client the line just says it is checking. */
  client?: Pick<ApiClient, 'judgmentStatus'> | null;
  port?: number;
}

// One row per config.models role, in plain words: what the work is, not the
// role's config key. The key stays searchable through `keywords`.
const ROLE_INFO: Record<keyof ModelConfig, { label: string; hint: string }> = {
  execute: { label: 'Coding runs', hint: 'Agents that change your code.' },
  overseer: {
    label: 'Overseer',
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
  summarize: {
    label: 'Summaries',
    hint: 'Titles and summaries.',
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

// The chat streaming switches (`overseer.stream`, `runs.stream`), each mode
// with the line that says what it does; the row shows the chosen one's.
const OVERSEER_STREAM: {
  value: OverseerStreamMode;
  label: string;
  hint: string;
}[] = [
  {
    value: 'live',
    label: 'Live',
    hint: 'Its reply appears as it writes, and what it says between steps stays in the chat.',
  },
  {
    value: 'narration',
    label: 'Narration',
    hint: 'What it says between steps stays in the chat, each part shown once it is finished.',
  },
  {
    value: 'off',
    label: 'Off',
    hint: 'One reply per turn, shown when the turn is done.',
  },
];

const RUN_STREAM: { value: RunStreamMode; label: string; hint: string }[] = [
  {
    value: 'live',
    label: 'Live',
    hint: "The agent's text appears as it writes.",
  },
  {
    value: 'off',
    label: 'Off',
    hint: "Each part of the agent's text appears once it is finished.",
  },
];

/** The line under a streaming row: what the chosen mode does. */
function streamHint(
  modes: { value: string; hint: string }[],
  value: string
): string {
  return modes.find((m) => m.value === value)?.hint ?? '';
}

/** Settings → Agents: models and effort per kind of work, how their chats
 *  stream, the limits runs work under, what they may do unasked, and the
 *  agents a dispatch can use.
 *  Save feedback lives in the shell, not here: this only calls `onSave`. */
export function AgentsSection({
  config,
  executors,
  onSave,
  canOperate,
  client = null,
  port,
}: AgentsSectionProps) {
  const agentNames = [
    ...new Set([
      ...(executors?.executors.map((e) => e.name) ?? []),
      ...Object.keys(config.executors ?? {}),
      config.orchestrator.executor,
    ]),
  ];
  const overseerStream = overseerSettings(config).stream;
  const runStream = runSettings(config).stream;
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
                    label={`${info.label} model`}
                    value={current}
                    options={modelChoices(current).map((m) => ({
                      value: m.id,
                      label: m.label,
                    }))}
                    className={styles.model}
                    onChange={(id) => void onSave({ models: { [role]: id } })}
                  />
                  {hasEffort(role) ? (
                    <Select
                      label={`${info.label} effort`}
                      value={config.effort?.[role] ?? DEFAULT_EFFORT_ID}
                      options={effortOptions(undefined).map((o) => ({
                        value: o.id,
                        label: o.label,
                      }))}
                      className={styles.effort}
                      onChange={(id) =>
                        void onSave({
                          effort: { [role]: effortFromId(id) ?? null },
                        })
                      }
                    />
                  ) : (
                    // Holds the column so every model select lines up.
                    <span aria-hidden className={styles.effort} />
                  )}
                </>
              }
            />
          );
        })}
      </SettingsGroup>

      <SettingsGroup
        title="Judgments"
        hint="Jev answers quick yes/no calls: triage, readiness, run model tier and whether a message starts a new Overseer conversation. Without it, each falls back to the plain behaviour."
        keywords="typesafe jev"
      >
        <JudgmentStatusRow client={client} port={port} />
      </SettingsGroup>

      <SettingsGroup
        title="Streaming"
        hint="How a chat shows an agent's text while it works. Live is the default; the others are for when streaming misbehaves. A change applies from the Overseer's next turn, and to runs started after it."
        keywords="stream live text typing chat"
      >
        <ModeSetting<OverseerStreamMode>
          id="overseer-stream"
          title="Overseer"
          subtitle={streamHint(OVERSEER_STREAM, overseerStream)}
          keywords="overseer.stream overseer narration"
          value={overseerStream}
          choices={OVERSEER_STREAM}
          onSave={(stream) => void onSave({ overseer: { stream } })}
        />
        <ModeSetting<RunStreamMode>
          id="runs-stream"
          title="Runs"
          subtitle={streamHint(RUN_STREAM, runStream)}
          keywords="runs.stream task run agent"
          value={runStream}
          choices={RUN_STREAM}
          onSave={(stream) => void onSave({ runs: { stream } })}
        />
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
          id="milestone-concurrency"
          title="Runs at once per milestone"
          subtitle="How many of a milestone's tasks start together when you dispatch it."
          keywords="concurrency parallel"
          value={config.orchestrator.milestoneConcurrency}
          onSave={(n) => n !== null && void onSave({ milestoneConcurrency: n })}
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
        <SwitchSetting
          id="unlimited-spend"
          title="Unlimited spend"
          subtitle="No spend cap on runs or fan-outs, and Send agents starts straight away without asking for a ceiling."
          keywords="budget cap cost dollars unlimitedSpend ceiling no limit"
          checked={config.orchestrator.unlimitedSpend}
          onSave={(unlimitedSpend) => void onSave({ unlimitedSpend })}
        />
        {/* Hidden rather than disabled: the daemon ignores the cap while the switch
            is on, and keeps the saved value for when it goes off. */}
        {!config.orchestrator.unlimitedSpend && (
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
        )}
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
          <RadioGroup
            label="When an agent wants to run a command or edit a file"
            value={config.orchestrator.permissionMode}
            options={PERMISSION_MODES.map(([mode, label]) => ({
              value: mode,
              label,
            }))}
            onChange={(next) => {
              const mode = PERMISSION_MODES.find(([m]) => m === next)?.[0];
              if (mode !== undefined) void onSave({ permissionMode: mode });
            }}
          />
          {!OFFERED_MODES.includes(config.orchestrator.permissionMode) && (
            <SettingsHint>
              Currently &ldquo;{config.orchestrator.permissionMode}&rdquo;, set
              by hand in .dispatch/config.yml.
            </SettingsHint>
          )}
        </SettingsRow>
        <ChoiceSetting
          id="overseer-autonomy"
          title="What your agent does without asking"
          subtitle="Balanced files and edits tasks at once and asks once per conversation before dispatching or merging. Cancelling or discarding a run and sending as you always ask."
          keywords="overseer autonomy assistant approve card cautious balanced trusting"
          value={overseerAutonomy(config)}
          choices={AUTONOMY_CHOICES}
          onSave={(autonomy) => void onSave({ overseer: { autonomy } })}
        />
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
