import { describe, expect, test } from 'bun:test';

import { decideBodySave } from './taskBodyEdit';

const OPENED = '\n## Description\n\noriginal\n\n## Activity\n';

describe('decideBodySave', () => {
  test('saves an edited draft when the task has not moved underneath it', () => {
    const draft = '\n## Description\n\nedited\n\n## Activity\n';
    expect(decideBodySave(OPENED, OPENED, draft)).toEqual({
      kind: 'save',
      body: draft,
    });
  });

  test('reports an untouched draft as unchanged rather than saving it', () => {
    expect(decideBodySave(OPENED, OPENED, OPENED)).toEqual({
      kind: 'unchanged',
    });
  });

  test('refuses a draft whose task gained an Activity line while it was open', () => {
    // What an agent's task_comment does to the body mid-edit.
    const current = `${OPENED}\n- agent left a note\n`;
    const draft = '\n## Description\n\nedited\n\n## Activity\n';
    expect(decideBodySave(OPENED, current, draft)).toEqual({ kind: 'stale' });
  });

  test('closes cleanly when a concurrent write happens to match the draft', () => {
    const draft = '\n## Description\n\nedited\n\n## Activity\n';
    // No conflict worth raising: writing the draft would be a no-op.
    expect(decideBodySave(OPENED, draft, draft)).toEqual({ kind: 'unchanged' });
  });
});
