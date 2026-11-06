import { Button } from '@dispatch/ui';

import { SetupStepRow } from './SetupStepRow';

// Setup's optional Linear step (Better Tracker's /setup, where connecting
// Linear is the first thing): whether this project already plans with
// Linear, and a way to connect it now. Connecting finishes setup and opens
// Settings → Linear, where the sign-in and the team link live, rather than
// repeating them here.

interface LinearStepProps {
  /** The daemon's Linear sync: connected, not, or not known yet. */
  connected: boolean | null;
  onConnect: () => void;
}

export function LinearStep({ connected, onConnect }: LinearStepProps) {
  if (connected === null) {
    return (
      <SetupStepRow status="checking" title="Linear" message="Checking…" />
    );
  }
  if (connected) {
    return (
      <SetupStepRow
        status="ok"
        title="Linear"
        message="Connected: your Linear projects, milestones and issues plan here."
      />
    );
  }
  return (
    <SetupStepRow
      status="waiting"
      title="Linear (optional)"
      message="Plan with your Linear projects, milestones and issues: My week, the timeline, allocation and the daily digest. You can connect it later in Settings."
      action={
        <Button size="sm" onClick={onConnect}>
          Connect Linear
        </Button>
      }
    />
  );
}
