import type { Planner, PlanProposal } from '../planner.js';

// A scriptable stand-in for ClaudePlanner (mirrors executors/fake.ts's
// FakeExecutor): constructed with either a fixed proposal to return, or an
// error message to reject with. CI never calls the real ClaudePlanner —
// every planner test in this package goes through FakePlanner instead.
export type FakePlannerScript =
  | { ok: true; proposal: PlanProposal }
  | { ok: false; error: string };

export class FakePlanner implements Planner {
  constructor(private readonly script: FakePlannerScript) {}

  async plan(_prompt: string): Promise<PlanProposal> {
    if (!this.script.ok) {
      throw new Error(this.script.error);
    }
    return this.script.proposal;
  }
}
