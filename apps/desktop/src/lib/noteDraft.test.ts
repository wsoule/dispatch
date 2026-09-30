import { describe, expect, it } from 'bun:test';

import { isSubmitChord } from './noteDraft';

describe('isSubmitChord', () => {
  it('is ⌘⏎ or Ctrl⏎', () => {
    expect(isSubmitChord({ key: 'Enter', metaKey: true, ctrlKey: false })).toBe(
      true
    );
    expect(isSubmitChord({ key: 'Enter', metaKey: false, ctrlKey: true })).toBe(
      true
    );
  });

  it('is not a plain Enter — that is a newline in the field', () => {
    expect(
      isSubmitChord({ key: 'Enter', metaKey: false, ctrlKey: false })
    ).toBe(false);
  });

  it('is not any other chord', () => {
    expect(isSubmitChord({ key: 'k', metaKey: true, ctrlKey: false })).toBe(
      false
    );
  });
});
