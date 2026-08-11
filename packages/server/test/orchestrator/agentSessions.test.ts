import { describe, expect, it } from 'bun:test';

import { buildAgentSessions } from '../../src/orchestrator/agentSessions.js';
import type { DraftRecord, PlanRecord } from '../../src/orchestrator/plan.js';
import type { WardenRecord } from '../../src/orchestrator/warden.js';

function plan(over: Partial<PlanRecord> = {}): PlanRecord {
  return {
    id: 'plan-1',
    prompt: 'build a widget',
    plannerName: 'claude',
    role: 'plan',
    state: 'running',
    messages: [],
    questions: [],
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
    ...over,
  };
}

function draft(over: Partial<DraftRecord> = {}): DraftRecord {
  return {
    id: 'draft-1',
    prompt: 'fix the flaky test',
    plannerName: 'claude',
    state: 'ready',
    message: 'done',
    proposal: null,
    questions: [],
    error: null,
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
    ...over,
  };
}

function warden(over: Partial<WardenRecord> = {}): WardenRecord {
  return {
    id: 'w-1',
    prompt: 'what is running?',
    backendName: 'claude',
    state: 'ready',
    messages: [],
    pendingActions: [],
    undeliveredDecisions: [],
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
    ...over,
  };
}

describe('buildAgentSessions', () => {
  it('normalizes each record kind, splitting plans by role', () => {
    const sessions = buildAgentSessions(
      [
        plan({ id: 'plan-1' }),
        plan({ id: 'plan-2', role: 'enrich', subject: 'Fix the header' }),
      ],
      [draft()],
      [warden()]
    );
    const byId = new Map(sessions.map((s) => [s.id, s]));
    expect(byId.get('plan-1')?.kind).toBe('plan');
    expect(byId.get('plan-2')?.kind).toBe('enrich');
    expect(byId.get('draft-1')?.kind).toBe('draft');
    expect(byId.get('w-1')?.kind).toBe('warden');
  });

  it('prefers an enrich plan subject over its boilerplate prompt', () => {
    const [session] = buildAgentSessions(
      [
        plan({
          role: 'enrich',
          prompt: 'A task in this repository is under-specified…',
          subject: 'Fix the header',
        }),
      ],
      [],
      []
    );
    expect(session.title).toBe('Fix the header');
  });

  it('truncates a long multi-line subject like any other title', () => {
    // An inbox enrich plan's subject is the raw captured text, not a title.
    const [session] = buildAgentSessions(
      [plan({ role: 'enrich', subject: `${'y'.repeat(200)}\nsecond line` })],
      [],
      []
    );
    expect(session.title).toHaveLength(121); // 120 chars + ellipsis
    expect(session.title.endsWith('…')).toBe(true);
  });

  it('falls back to the prompt first non-empty line, truncated', () => {
    const [long] = buildAgentSessions(
      [plan({ prompt: `\n  ${'x'.repeat(200)}\nsecond line` })],
      [],
      []
    );
    expect(long.title).toHaveLength(121); // 120 chars + ellipsis
    expect(long.title.endsWith('…')).toBe(true);

    const [short] = buildAgentSessions(
      [plan({ prompt: '\n\n  build a widget  \nmore' })],
      [],
      []
    );
    expect(short.title).toBe('build a widget');
  });

  it('carries state and error, mapping a draft null error to absent', () => {
    const sessions = buildAgentSessions(
      [plan({ state: 'failed', error: 'boom' })],
      [draft({ error: null })],
      []
    );
    const failed = sessions.find((s) => s.id === 'plan-1');
    expect(failed?.state).toBe('failed');
    expect(failed?.error).toBe('boom');
    expect(sessions.find((s) => s.id === 'draft-1')?.error).toBeUndefined();
  });

  it('sorts by most recent activity across kinds', () => {
    const sessions = buildAgentSessions(
      [plan({ id: 'plan-1', updatedAt: '2026-08-11T01:00:00.000Z' })],
      [draft({ id: 'draft-1', updatedAt: '2026-08-11T03:00:00.000Z' })],
      [warden({ id: 'w-1', updatedAt: '2026-08-11T02:00:00.000Z' })]
    );
    expect(sessions.map((s) => s.id)).toEqual(['draft-1', 'w-1', 'plan-1']);
  });
});
