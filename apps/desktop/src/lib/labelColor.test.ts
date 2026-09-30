import { afterEach, describe, expect, test } from 'bun:test';

import { applyLabelColors, colorForLabel } from './labelColor';

// The custom property colorForLabel reads, pulled out of its `var(...)`.
function propertyOf(label: string): string {
  return (
    /^var\((--label-color-[0-9a-z]+),/.exec(colorForLabel(label))?.[1] ?? ''
  );
}

afterEach(() => applyLabelColors(null));

describe('colorForLabel', () => {
  test('is stable for the same label, whatever its case', () => {
    expect(colorForLabel('ui')).toBe(colorForLabel('ui'));
    expect(propertyOf('Type/Bug')).toBe(propertyOf('type/bug'));
  });

  test('falls back to one of the eight categorical tokens', () => {
    for (const label of ['ui', 'kanban', 'dispatchd', 'merge-queue', '']) {
      expect(colorForLabel(label)).toMatch(
        /^var\(--label-color-[0-9a-z]+, var\(--project-color-[1-8]\)\)$/
      );
    }
  });
});

describe('applyLabelColors', () => {
  test('publishes registry colors where chips read them, and clears them', () => {
    const root = document.documentElement;
    applyLabelColors([
      { name: 'Bug', group: 'Type', color: '#eb5757' },
      { name: 'web', color: null },
    ]);
    expect(root.style.getPropertyValue(propertyOf('Type/Bug'))).toBe('#eb5757');
    // An uncolored label keeps the hashed hue.
    expect(root.style.getPropertyValue(propertyOf('web'))).toBe('');

    applyLabelColors([{ name: 'web', color: '#5e6ad2' }]);
    expect(root.style.getPropertyValue(propertyOf('Type/Bug'))).toBe('');
    expect(root.style.getPropertyValue(propertyOf('web'))).toBe('#5e6ad2');

    applyLabelColors(null);
    expect(root.style.getPropertyValue(propertyOf('web'))).toBe('');
  });
});
