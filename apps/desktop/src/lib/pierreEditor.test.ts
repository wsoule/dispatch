import { Editor } from '@pierre/diffs/edit';
import { describe, expect, test } from 'bun:test';

import { createReviewEditor } from './pierreEditor';

describe('createReviewEditor', () => {
  test('builds a real Pierre `Editor`, not a stub', () => {
    const editor = createReviewEditor({});
    expect(editor).toBeInstanceOf(Editor);
  });

  test('exposes the `DiffsEditor` surface CodeView drives (attach, tear down)', () => {
    const editor = createReviewEditor({});
    expect(typeof editor.edit).toBe('function');
    expect(typeof editor.cleanUp).toBe('function');
    // No file has ever been attached, so tearing down immediately must not throw.
    expect(() => editor.cleanUp()).not.toThrow();
  });

  test('accepts caller options alongside the fixed review settings without throwing', () => {
    // `historyMaxEntries`/`onAttach` are caller-supplied; `persistState`/`matchBrackets`/
    // `roundedSelection` are the ones this factory fixes. Both sets landing in one
    // constructor call must not conflict.
    expect(() =>
      createReviewEditor({ historyMaxEntries: 50, onAttach: () => {} })
    ).not.toThrow();
  });
});
