import type { LedgerEntry, TaskDoc } from '@dispatch/core';
import { describe, expect, it } from 'bun:test';

import { buildTaskPrompt } from '../../src/orchestrator/prompt.js';

function fixtureLedgerEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: 'l-abc123',
    epicId: 'e-def456',
    sourceTaskId: 't-earlier1',
    kind: 'hazard',
    title: 'withActionFeedback swallows rejections',
    detail: 'every catch downstream of it is dead code — check response.ok',
    appliesTo: [],
    createdAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

// A fixture task/epic pair with every field buildTaskPrompt reads set to a
// fixed, deterministic value, so a snapshot of its output is exact-text stable.
function fixtureTask(): TaskDoc {
  return {
    meta: {
      id: 't-abc123',
      title: 'Add login rate limiting',
      status: 'todo',
      kind: 'task',
      parent: 'e-def456',
      milestone: null,
      blockedBy: [],
      labels: [],
      priority: 'high',
      assignee: 'agent',
      created: '2026-07-20T00:00:00.000Z',
      updated: '2026-07-20T00:00:00.000Z',
      external: null,
      selfReview: false,
      writes: [],
      risk: 'routine',
      model: null,
    },
    body:
      '\n## Description\n\nAdd a rate limiter to the login endpoint.\n\n' +
      '## Acceptance Criteria\n\n- 5 attempts per minute per IP\n\n' +
      '## Activity\n',
  };
}

function fixtureEpic(): TaskDoc {
  return {
    meta: {
      id: 'e-def456',
      title: 'Harden auth',
      status: 'in-progress',
      kind: 'epic',
      parent: null,
      milestone: null,
      blockedBy: [],
      labels: [],
      priority: 'high',
      assignee: 'none',
      created: '2026-07-01T00:00:00.000Z',
      updated: '2026-07-01T00:00:00.000Z',
      external: null,
      selfReview: false,
      writes: [],
      risk: 'routine',
      model: null,
    },
    body: '\n## Description\n\nMake the auth system resistant to abuse.\n\n## Activity\n',
  };
}

describe('buildTaskPrompt', () => {
  it('matches the exact prompt text for a fixture task with a parent epic', () => {
    expect(buildTaskPrompt(fixtureTask(), fixtureEpic())).toMatchSnapshot();
  });

  it('omits the epic section entirely for a parentless task', () => {
    const task = fixtureTask();
    task.meta.parent = null;
    const prompt = buildTaskPrompt(task, null);
    expect(prompt).not.toContain('Parent epic');
    expect(prompt).toContain('Add login rate limiting');
  });

  it('always includes the collaboration note and commit instruction', () => {
    const prompt = buildTaskPrompt(fixtureTask(), fixtureEpic());
    expect(prompt).toContain('run_list');
    expect(prompt).toContain('task_comment');
    expect(prompt).toContain('ask_user');
    expect(prompt).toContain('Commit your work');
  });

  it('includes the task id/title and its full body verbatim', () => {
    const task = fixtureTask();
    const prompt = buildTaskPrompt(task, null);
    expect(prompt).toContain(task.meta.id);
    expect(prompt).toContain(task.meta.title);
    expect(prompt).toContain('5 attempts per minute per IP');
  });

  it('omits the self-review instruction when selfReview is false', () => {
    const prompt = buildTaskPrompt(fixtureTask(), null);
    expect(prompt).not.toContain('self-review your work');
  });

  it('appends the self-review instruction when selfReview is true', () => {
    const task = fixtureTask();
    task.meta.selfReview = true;
    const prompt = buildTaskPrompt(task, null);
    expect(prompt).toContain('self-review your work');
    expect(prompt).toContain('Only finish when the review comes back clean.');
  });

  it('renders no ledger section at all when there are no entries', () => {
    const prompt = buildTaskPrompt(fixtureTask(), fixtureEpic(), []);
    expect(prompt).not.toContain('Findings and decisions');
  });

  it('renders each ledger entry as its kind, title, and detail', () => {
    const entries = [
      fixtureLedgerEntry(),
      fixtureLedgerEntry({
        id: 'l-def456',
        kind: 'decision',
        title: 'retry POSTs',
        detail: 'up to 3 times on 5xx',
      }),
    ];
    const prompt = buildTaskPrompt(fixtureTask(), fixtureEpic(), entries);
    expect(prompt).toContain('## Findings and decisions from earlier work');
    expect(prompt).toContain(
      '- **hazard**: withActionFeedback swallows rejections — every catch ' +
        'downstream of it is dead code — check response.ok'
    );
    expect(prompt).toContain(
      '- **decision**: retry POSTs — up to 3 times on 5xx'
    );
  });
});
