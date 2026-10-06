import type { AuthTier } from '@dispatch/client';

import {
  BETA_FEATURES,
  type BetaFeature,
  twoViewsAllowed,
  useBetaFlag,
} from '../../lib/betaFeatures';
import { isTeamLocalPage } from '../../lib/teamLocal';
import { SwitchSetting } from './fields';
import { SettingsGroup } from './SettingsGroup';

/** Beta features you can turn on and off on this machine. */
export function BetaGroup({ tier }: { tier: AuthTier | null }) {
  return (
    <SettingsGroup
      title="Beta"
      hint="Try features before they become the default. Saved on this machine only."
      keywords="beta experimental preview layout"
      requires="none"
    >
      {BETA_FEATURES.map((feature) => (
        <BetaRow
          key={feature.id}
          id={feature.id}
          title={feature.label}
          subtitle={feature.description}
          tier={tier}
        />
      ))}
    </SettingsGroup>
  );
}

function BetaRow({
  id,
  title,
  subtitle,
  tier,
}: {
  id: BetaFeature;
  title: string;
  subtitle: string;
  tier: AuthTier | null;
}) {
  const [on, setOn] = useBetaFlag(id);
  const allowed =
    id !== 'two-views' ||
    twoViewsAllowed({ teamLocal: isTeamLocalPage(), tier });
  return (
    <SwitchSetting
      id={`beta-${id}`}
      title={title}
      subtitle={subtitle}
      keywords={id}
      locked={allowed ? undefined : 'Only the project owner can try this here.'}
      checked={on && allowed}
      onSave={setOn}
    />
  );
}
