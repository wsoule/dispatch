import type { EscalationStep } from '@dispatch-foo/core/browser';
import { Button, Select } from '@dispatch/ui';

import styles from './EscalationEditor.module.css';
import { SettingsSearchable } from './search';
import kit from './settings.module.css';
import { SettingsGroup, SettingsHint, SettingsRow } from './SettingsGroup';

interface EscalationEditorProps {
  steps: EscalationStep[];
  onChange: (steps: EscalationStep[]) => void;
}

const STRATEGIES = [
  ['resume', 'Same agent'],
  ['fresh', 'Fresh agent'],
] as const;

const MODEL_TIERS = [
  ['standard', 'Usual model'],
  ['high', 'Stronger model'],
] as const;

// Rounds are positional; the fix loop reads them in order, so a gap left by a
// removal would be meaningless.
function renumber(steps: EscalationStep[]): EscalationStep[] {
  return steps.map((step, i) => ({ ...step, round: i + 1 }));
}

/** Editor for the fix-loop escalation ladder. Controlled: it holds no copy of
 *  the list, every mutation goes out through `onChange` already renumbered. */
export function EscalationEditor({ steps, onChange }: EscalationEditorProps) {
  function updateStep(index: number, patch: Partial<EscalationStep>) {
    onChange(
      steps.map((step, i) => (i === index ? { ...step, ...patch } : step))
    );
  }

  function removeStep(index: number) {
    onChange(renumber(steps.filter((_, i) => i !== index)));
  }

  function addStep() {
    onChange(
      renumber([
        ...steps,
        { round: 0, strategy: 'resume', modelTier: 'standard' },
      ])
    );
  }

  return (
    <SettingsGroup
      title="Escalation"
      hint="What each fix round tries. Rounds without a step here keep the same agent on the usual model."
      keywords="fix loop ladder rounds stronger model"
    >
      {steps.length === 0 && (
        <SettingsSearchable text="no escalation steps">
          <div className={kit.row}>
            <SettingsHint>
              No steps: every round keeps the same agent on the usual model.
            </SettingsHint>
          </div>
        </SettingsSearchable>
      )}
      {steps.map((step, index) => (
        <SettingsRow
          key={step.round}
          title={`Round ${String(step.round)}`}
          control={
            <>
              <Select
                label={`Round ${String(step.round)} strategy`}
                value={step.strategy}
                options={STRATEGIES.map(([value, label]) => ({ value, label }))}
                className={styles.strategy}
                onChange={(value) => {
                  const strategy = STRATEGIES.find(([v]) => v === value)?.[0];
                  if (strategy !== undefined) updateStep(index, { strategy });
                }}
              />
              <Select
                label={`Round ${String(step.round)} model tier`}
                value={step.modelTier}
                options={MODEL_TIERS.map(([value, label]) => ({
                  value,
                  label,
                }))}
                className={styles.tier}
                onChange={(value) => {
                  const modelTier = MODEL_TIERS.find(([v]) => v === value)?.[0];
                  if (modelTier !== undefined) updateStep(index, { modelTier });
                }}
              />
              <Button
                type="button"
                variant="quiet"
                size="sm"
                aria-label={`Remove round ${String(step.round)}`}
                onClick={() => removeStep(index)}
              >
                Remove
              </Button>
            </>
          }
        />
      ))}
      <SettingsSearchable text="add escalation step round">
        <div className={kit.row}>
          <span>
            <Button variant="secondary" size="sm" onClick={addStep}>
              Add round
            </Button>
          </span>
        </div>
      </SettingsSearchable>
    </SettingsGroup>
  );
}
