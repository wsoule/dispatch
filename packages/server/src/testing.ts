// Public re-export of the fake executor/planner test doubles for consumers
// outside this package (currently apps/demo) that need real FakeExecutor/
// FakePlanner instances rather than a hand-mirrored type, unlike @dispatch/cli
// and @dispatch/mcp which deliberately avoid depending on this Bun-only
// package at all. Kept as its own subpath (rather than widening the root
// export) so importing it stays an explicit, visible choice.
export { FakeExecutor } from './orchestrator/executors/fake.js';
export type { FakeExecutorScript } from './orchestrator/executors/fake.js';
export { FakePlanner } from './orchestrator/planners/fake.js';
export type { PlanProposal } from './orchestrator/planner.js';
