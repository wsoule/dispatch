import type { ConfigPatch, DispatchConfig } from '@dispatch/core/browser';
import { QUEUE_FACTORS, queueWeights } from '@dispatch/core/browser';

import { NumberSetting } from './fields';
import { SettingsGroup, SettingsRow } from './SettingsGroup';

interface Props {
  config: DispatchConfig;
  onSave: (patch: ConfigPatch) => Promise<unknown>;
}

/**
 * Settings → Autonomy → What runs next: how much each factor counts when
 * Dispatch ranks the ready tasks. A weight of 0 leaves a factor out.
 */
export function QueueWeightsGroup({ config, onSave }: Props) {
  const result = queueWeights(config);
  const hint =
    'How much each factor counts when choosing which ready task runs next. Only the proportions matter; 0 ignores a factor.';
  if ('error' in result) {
    // Nothing here to change, only a config.yml to fix by hand.
    return (
      <SettingsGroup
        title="Task ranking"
        hint={hint}
        keywords="queue weights"
        requires="none"
      >
        <SettingsRow
          title="The ranking in config.yml couldn't be read"
          subtitle={result.error}
        />
      </SettingsGroup>
    );
  }
  const { weights } = result;
  return (
    <SettingsGroup
      title="Task ranking"
      hint={hint}
      keywords="queue weights priority"
    >
      {QUEUE_FACTORS.map((factor) => (
        <NumberSetting
          key={factor.key}
          id={`queue-weight-${factor.key}`}
          title={factor.label}
          subtitle={`Counts ${factor.describes}.`}
          value={weights[factor.key]}
          min={0}
          integer={false}
          onSave={(n) =>
            n !== null &&
            void onSave({ queue: { weights: { [factor.key]: n } } })
          }
        />
      ))}
    </SettingsGroup>
  );
}
