import { afterEach, describe, expect, test } from 'bun:test';

import {
  applyLabelColors,
  labelColors,
  labelHex,
  subscribeLabelColors,
} from './labelColor';

afterEach(() => applyLabelColors(null));

describe('applyLabelColors', () => {
  test('replaces the registry on every apply, and null clears it', () => {
    applyLabelColors([
      { name: 'Bug', group: 'Type', color: '#eb5757' },
      { name: 'web', color: null },
    ]);
    expect(labelHex('Type/Bug')).toBe('#eb5757');
    // An uncolored label has no registry color.
    expect(labelHex('web')).toBeUndefined();

    applyLabelColors([{ name: 'web', color: '#5e6ad2' }]);
    expect(labelHex('Type/Bug')).toBeUndefined();
    expect(labelHex('web')).toBe('#5e6ad2');

    applyLabelColors(null);
    expect(labelHex('web')).toBeUndefined();
  });

  test('writes no custom properties on the document root', () => {
    applyLabelColors([{ name: 'web', color: '#5e6ad2' }]);
    expect(document.documentElement.style.cssText).not.toContain(
      '--label-color-'
    );
  });
});

describe('labelHex', () => {
  test('returns the registry hex, case-insensitively, and undefined otherwise', () => {
    expect(labelHex('Type/Bug')).toBeUndefined();
    applyLabelColors([
      { name: 'Bug', group: 'Type', color: '#eb5757' },
      { name: 'web', color: null },
    ]);
    expect(labelHex('Type/Bug')).toBe('#eb5757');
    expect(labelHex('type/bug')).toBe('#eb5757');
    expect(labelHex('web')).toBeUndefined();
    expect(labelHex('docs')).toBeUndefined();
    applyLabelColors(null);
    expect(labelHex('Type/Bug')).toBeUndefined();
  });
});

describe('subscribeLabelColors', () => {
  test('fires on every apply until unsubscribed, with a new snapshot', () => {
    let calls = 0;
    const before = labelColors();
    const unsubscribe = subscribeLabelColors(() => {
      calls += 1;
    });
    applyLabelColors([{ name: 'web', color: '#5e6ad2' }]);
    expect(calls).toBe(1);
    expect(labelColors()).not.toBe(before);
    expect(labelColors().hex('WEB')).toBe('#5e6ad2');
    expect(before.hex('web')).toBeUndefined();
    unsubscribe();
    applyLabelColors(null);
    expect(calls).toBe(1);
  });
});
