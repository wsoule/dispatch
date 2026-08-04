import type { EscalationStep } from '@dispatch/core/browser';

import { Button } from '@/ui/button';
import { HintText, Panel, PanelHeader, PanelRow } from '@/ui/chrome';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

interface EscalationEditorProps {
  steps: EscalationStep[];
  onChange: (steps: EscalationStep[]) => void;
}

const STRATEGIES = [
  ['resume', 'Resume'],
  ['fresh', 'Fresh agent'],
] as const;

const MODEL_TIERS = [
  ['standard', 'Standard'],
  ['high', 'High'],
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
    <Panel>
      <PanelHeader>Escalation ladder</PanelHeader>
      {steps.length === 0 && (
        <PanelRow>
          <HintText>
            No escalation steps — every round resumes at the standard tier.
          </HintText>
        </PanelRow>
      )}
      {steps.map((step, index) => (
        <PanelRow key={step.round}>
          <span className="min-w-0 flex-1 text-[13px] font-medium">
            Round {step.round}
          </span>
          <Select
            value={step.strategy}
            onValueChange={(value) =>
              updateStep(index, {
                strategy: value as EscalationStep['strategy'],
              })
            }
          >
            <SelectTrigger
              size="sm"
              aria-label={`Round ${step.round} strategy`}
              className="w-[130px] shrink-0 text-[12px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STRATEGIES.map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={step.modelTier}
            onValueChange={(value) =>
              updateStep(index, {
                modelTier: value as EscalationStep['modelTier'],
              })
            }
          >
            <SelectTrigger
              size="sm"
              aria-label={`Round ${step.round} model tier`}
              className="w-[130px] shrink-0 text-[12px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODEL_TIERS.map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Remove round ${step.round}`}
            onClick={() => removeStep(index)}
          >
            Remove
          </Button>
        </PanelRow>
      ))}
      <PanelRow>
        <Button type="button" variant="outline" size="sm" onClick={addStep}>
          Add step
        </Button>
      </PanelRow>
    </Panel>
  );
}
