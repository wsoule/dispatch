import type { TaskDraft } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import type { EditableTaskDraft } from './taskDraft';
import {
  editableDraftFrom,
  editableDraftToCreateInput,
  isDraftSaveable,
} from './taskDraft';

const PLANNED: TaskDraft = {
  title: 'Add a retry to the uploader',
  description: 'Uploads fail on a flaky network with no retry.',
  acceptanceCriteria: ['Retries three times', 'Backs off exponentially'],
  priority: 'high',
};

function editable(
  overrides: Partial<EditableTaskDraft> = {}
): EditableTaskDraft {
  return { ...editableDraftFrom(PLANNED, 'todo'), ...overrides };
}

describe('editableDraftFrom', () => {
  test('carries the planner fields through and seeds the given status with no epic', () => {
    const draft = editableDraftFrom(PLANNED, 'in-progress');
    expect(draft.title).toBe(PLANNED.title);
    expect(draft.acceptanceCriteria).toEqual(PLANNED.acceptanceCriteria);
    expect(draft.priority).toBe('high');
    expect(draft.status).toBe('in-progress');
    expect(draft.parent).toBeNull();
  });
});

describe('isDraftSaveable', () => {
  test('requires a non-blank title, matching CreateTaskModal', () => {
    expect(isDraftSaveable(editable())).toBe(true);
    expect(isDraftSaveable(editable({ title: '' }))).toBe(false);
    expect(isDraftSaveable(editable({ title: '   ' }))).toBe(false);
  });
});

describe('editableDraftToCreateInput', () => {
  test('saves through the same CreateInput shape the modal uses', () => {
    const input = editableDraftToCreateInput(
      editable({ status: 'draft', parent: 'e-1' })
    );
    expect(input.title).toBe(PLANNED.title);
    expect(input.kind).toBe('task');
    expect(input.priority).toBe('high');
    expect(input.status).toBe('draft');
    expect(input.parent).toBe('e-1');
  });

  test('folds the acceptance criteria into the description as a bullet block', () => {
    const input = editableDraftToCreateInput(editable());
    expect(input.description).toContain(PLANNED.description);
    expect(input.description).toContain('- Retries three times');
    expect(input.description).toContain('- Backs off exponentially');
  });

  test('drops blank criteria rows left behind by an unfilled "Add criterion"', () => {
    const input = editableDraftToCreateInput(
      editable({ acceptanceCriteria: ['Retries three times', '', '   '] })
    );
    expect(input.description).toContain('- Retries three times');
    expect(input.description).not.toContain('- \n');
    expect(input.description?.trimEnd().endsWith('- Retries three times')).toBe(
      true
    );
  });

  test('omits the criteria block entirely when every row is blank', () => {
    const input = editableDraftToCreateInput(
      editable({ acceptanceCriteria: ['', '  '] })
    );
    expect(input.description).toBe(PLANNED.description);
  });

  test('trims a title padded by inline editing', () => {
    const input = editableDraftToCreateInput(
      editable({ title: '  Add a retry  ' })
    );
    expect(input.title).toBe('Add a retry');
  });
});
