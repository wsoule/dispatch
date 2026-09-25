import type { ConfigPatch, DispatchConfig } from '@dispatch/core/browser';

import { PullRequestsGroup, StatusesGroup } from './ProjectGroups';

interface GeneralSectionProps {
  config: DispatchConfig;
  onSave: (patch: ConfigPatch) => Promise<unknown>;
  canOperate: boolean;
}

/** Settings → General: the board's columns and where PR checkouts go. */
export function GeneralSection({
  config,
  onSave,
  canOperate,
}: GeneralSectionProps) {
  return (
    <>
      <StatusesGroup config={config} onSave={onSave} />
      <PullRequestsGroup
        config={config}
        onSave={onSave}
        canOperate={canOperate}
      />
    </>
  );
}
