import { useSyncExternalStore } from 'react';

import { runSteps } from '../lib/runStep';

/** A live run's latest step ("Editing src/foo.ts"), or null until its next log entry.
 * Re-renders only the caller, at most 4 times a second. */
export function useRunStep(runId: string | null): string | null {
  return useSyncExternalStore(runSteps.subscribe, () =>
    runId === null ? null : runSteps.get(runId)
  );
}
