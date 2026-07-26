import { describe, expect, it } from 'bun:test';

import type { PlanProposal } from '../../src/orchestrator/planner.js';
import { FakePlanner } from '../../src/orchestrator/planners/fake.js';

const PROPOSAL_A: PlanProposal = {
  tasks: [
    {
      title: 'Task A',
      description: 'first',
      acceptanceCriteria: [],
      blockedByIndices: [],
      priority: 'medium',
    },
  ],
};

const PROPOSAL_B: PlanProposal = {
  tasks: [
    {
      title: 'Task A',
      description: 'first',
      acceptanceCriteria: [],
      blockedByIndices: [],
      priority: 'medium',
    },
    {
      title: 'Task B',
      description: 'second',
      acceptanceCriteria: [],
      blockedByIndices: [0],
      priority: 'low',
    },
  ],
};

describe('FakePlanner single-proposal script', () => {
  it('returns the fixed proposal from start()', async () => {
    const planner = new FakePlanner({ ok: true, proposal: PROPOSAL_A });
    const turn = await planner.start('build a thing');
    expect(turn.proposal).toEqual(PROPOSAL_A);
    expect(typeof turn.reply).toBe('string');
  });

  it('returns the same fixed proposal from every follow-up sendMessage()', async () => {
    const planner = new FakePlanner({ ok: true, proposal: PROPOSAL_A });
    const first = await planner.start('build a thing');
    const second = await planner.sendMessage(first.sessionId, 'change it');
    expect(second.proposal).toEqual(PROPOSAL_A);
  });

  it('rejects from start() and sendMessage() when the script is an error', async () => {
    const planner = new FakePlanner({ ok: false, error: 'planner exploded' });
    await expect(planner.start('anything')).rejects.toThrow('planner exploded');
    await expect(planner.sendMessage(undefined, 'anything')).rejects.toThrow(
      'planner exploded'
    );
  });
});

describe('FakePlanner scripted multi-turn conversation', () => {
  it('advances through scripted turns as sessionId is threaded back in', async () => {
    const planner = new FakePlanner({
      ok: true,
      turns: [
        { reply: 'here is a first draft', proposal: PROPOSAL_A },
        { reply: 'added the second task', proposal: PROPOSAL_B },
      ],
    });

    const first = await planner.start('build a thing');
    expect(first.reply).toBe('here is a first draft');
    expect(first.proposal).toEqual(PROPOSAL_A);

    const second = await planner.sendMessage(first.sessionId, 'add a task');
    expect(second.reply).toBe('added the second task');
    expect(second.proposal).toEqual(PROPOSAL_B);
  });

  it('is stateless across independent plans sharing one instance', async () => {
    // The registry hands the same FakePlanner to every plan; each plan's
    // position must live in the round-tripped sessionId, not in shared
    // planner state — so two independent start() calls both see turn 0.
    const planner = new FakePlanner({
      ok: true,
      turns: [
        { reply: 'draft', proposal: PROPOSAL_A },
        { reply: 'refined', proposal: PROPOSAL_B },
      ],
    });
    const planOne = await planner.start('plan one');
    const planTwo = await planner.start('plan two');
    expect(planOne.proposal).toEqual(PROPOSAL_A);
    expect(planTwo.proposal).toEqual(PROPOSAL_A);
  });

  it('throws once the scripted turns are exhausted', async () => {
    const planner = new FakePlanner({
      ok: true,
      turns: [{ reply: 'only turn', proposal: PROPOSAL_A }],
    });
    const first = await planner.start('build a thing');
    await expect(
      planner.sendMessage(first.sessionId, 'keep going')
    ).rejects.toThrow(/no scripted turn/);
  });
});
