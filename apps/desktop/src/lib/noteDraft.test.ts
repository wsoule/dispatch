import type { PlannedTask, PlanRecord } from '@dispatch/client';
import { describe, expect, it } from 'bun:test';

import {
  applyNotePlanRecord,
  editNoteDraftTask,
  failNoteDraft,
  isNoteDraftPending,
  NO_NOTE_DRAFT,
  startNoteDraft,
} from './noteDraft';

const DRAFTED: PlannedTask = {
  title: 'Split NotesView',
  description: 'It renders the composer, the rows, and the draft.',
  acceptanceCriteria: ['NotesView is under 200 lines'],
  blockedByIndices: [],
  priority: 'medium',
};

function record(patch: Partial<PlanRecord>): PlanRecord {
  return {
    id: 'plan-abc123',
    prompt: 'draft this note',
    plannerName: 'claude',
    role: 'enrich',
    messages: [
      { role: 'user', text: 'draft this note', at: '2026-07-26T00:00:00.000Z' },
    ],
    state: 'ready',
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
    sourceNoteId: 'nt-aaa',
    proposal: { tasks: [DRAFTED] },
    questions: [],
    ...patch,
  };
}

describe('note draft state', () => {
  it('is pending from the moment a draft is asked for', () => {
    const state = startNoteDraft('nt-aaa');
    expect(isNoteDraftPending(state, 'nt-aaa')).toBe(true);
    expect(isNoteDraftPending(state, 'nt-bbb')).toBe(false);
  });

  it('seeds the editable tasks once the plan is ready', () => {
    const state = applyNotePlanRecord(startNoteDraft('nt-aaa'), record({}));
    expect(state.tasks).toEqual([DRAFTED]);
    expect(isNoteDraftPending(state, 'nt-aaa')).toBe(false);
  });

  it('keeps in-progress edits when the same record is polled again', () => {
    const seeded = applyNotePlanRecord(startNoteDraft('nt-aaa'), record({}));
    const edited = editNoteDraftTask(seeded, 0, { title: 'my own title' });

    const repolled = applyNotePlanRecord(edited, record({}));
    expect(repolled).toBe(edited);
    expect(repolled.tasks?.[0].title).toBe('my own title');
  });

  it('ignores a record belonging to a previously drafted note', () => {
    // Clicking "draft with AI" on a second note while the first note's plan is still the one
    // being polled: that stale record must not seed the new note's row.
    const state = startNoteDraft('nt-bbb');
    expect(applyNotePlanRecord(state, record({ sourceNoteId: 'nt-aaa' }))).toBe(
      state
    );
  });

  it('ignores an ordinary plan started from the Plans view', () => {
    const state = startNoteDraft('nt-aaa');
    expect(
      applyNotePlanRecord(state, record({ sourceNoteId: undefined }))
    ).toBe(state);
  });

  it('stays pending while the plan is still running', () => {
    const state = applyNotePlanRecord(
      startNoteDraft('nt-aaa'),
      record({ state: 'running', proposal: undefined })
    );
    expect(isNoteDraftPending(state, 'nt-aaa')).toBe(true);
  });

  it('surfaces a failed plan on the note that asked for it', () => {
    const state = applyNotePlanRecord(
      startNoteDraft('nt-aaa'),
      record({ state: 'failed', proposal: undefined, error: 'planner died' })
    );
    expect(state.error).toBe('planner died');
    expect(isNoteDraftPending(state, 'nt-aaa')).toBe(false);
  });

  it('falls back to a generic message when a failed plan has no error', () => {
    const state = applyNotePlanRecord(
      startNoteDraft('nt-aaa'),
      record({ state: 'failed', proposal: undefined })
    );
    expect(state.error).not.toBeNull();
  });

  it('applies nothing when no draft is open', () => {
    expect(applyNotePlanRecord(NO_NOTE_DRAFT, record({}))).toBe(NO_NOTE_DRAFT);
  });

  it('edits only the addressed task', () => {
    const seeded = applyNotePlanRecord(
      startNoteDraft('nt-aaa'),
      record({
        proposal: { tasks: [DRAFTED, { ...DRAFTED, title: 'Second' }] },
      })
    );
    const edited = editNoteDraftTask(seeded, 1, { priority: 'urgent' });
    expect(edited.tasks?.[0]).toEqual(DRAFTED);
    expect(edited.tasks?.[1].priority).toBe('urgent');
    expect(edited.tasks?.[1].title).toBe('Second');
  });

  it('records a request failure against the open draft', () => {
    const state = failNoteDraft(startNoteDraft('nt-aaa'), 'daemon unreachable');
    expect(state.error).toBe('daemon unreachable');
    expect(isNoteDraftPending(state, 'nt-aaa')).toBe(false);
  });
});
