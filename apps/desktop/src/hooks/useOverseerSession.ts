// The Overseer session lives in @dispatch/client; desktop binds it to the webview's
// localStorage and the dev fake-backend switch, so call sites stay unchanged.
import type { EffortLevel } from '@dispatch-foo/core/browser';
import {
  type ApiClient,
  browserStorage,
  type OverseerSession,
  type OverseerSessionOptions,
  useOverseerSession as useOverseerSessionIn,
} from '@dispatch/client';

import { isFakeOverseerDevToolEnabled } from '../lib/devTools';

export {
  applyOverseerDelta,
  invalidateOverseerEvent,
  overseerKey,
  overseerKeyPrefix,
  resetLiveText,
} from '@dispatch/client';
export type {
  OverseerApprovalDecision,
  OverseerSession,
} from '@dispatch/client';

const OPTIONS: OverseerSessionOptions = {
  storage: browserStorage(),
  fakeBackend: isFakeOverseerDevToolEnabled,
};

export function useOverseerSession(
  client: ApiClient | null,
  port: number | undefined,
  projectPath: string | null,
  configuredModel?: string,
  configuredEffort?: EffortLevel,
  resume = false
): OverseerSession {
  return useOverseerSessionIn(
    client,
    port,
    projectPath,
    configuredModel,
    configuredEffort,
    resume,
    OPTIONS
  );
}
