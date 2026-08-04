import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_DIFF_DISPLAY_SETTINGS,
  DIFF_DISPLAY_STORAGE_KEY,
  parseDiffDisplaySettings,
  serializeDiffDisplaySettings,
  toDiffRenderOptions,
} from './diffDisplay';

describe('parseDiffDisplaySettings', () => {
  test('a missing stored value falls back to the defaults', () => {
    expect(parseDiffDisplaySettings(null)).toEqual(
      DEFAULT_DIFF_DISPLAY_SETTINGS
    );
  });

  test('corrupt JSON falls back to the defaults rather than throwing', () => {
    expect(parseDiffDisplaySettings('{not json')).toEqual(
      DEFAULT_DIFF_DISPLAY_SETTINGS
    );
  });

  test('a non-object JSON value falls back to the defaults', () => {
    expect(parseDiffDisplaySettings('42')).toEqual(
      DEFAULT_DIFF_DISPLAY_SETTINGS
    );
    expect(parseDiffDisplaySettings('null')).toEqual(
      DEFAULT_DIFF_DISPLAY_SETTINGS
    );
    expect(parseDiffDisplaySettings('"unified"')).toEqual(
      DEFAULT_DIFF_DISPLAY_SETTINGS
    );
  });

  test('a full valid record round-trips through serialize/parse', () => {
    const settings = {
      layout: 'unified' as const,
      indicators: 'classic' as const,
      showBackgrounds: false,
      showLineNumbers: false,
      wrapLines: true,
      inlineHighlight: 'char' as const,
    };
    expect(
      parseDiffDisplaySettings(serializeDiffDisplaySettings(settings))
    ).toEqual(settings);
  });

  test('an unrecognised field value falls back to its own default while keeping the rest', () => {
    const stored = JSON.stringify({
      layout: 'sideways',
      indicators: 'classic',
      showBackgrounds: false,
      showLineNumbers: 'nope',
      wrapLines: 'nope',
      inlineHighlight: 'sideways',
    });
    expect(parseDiffDisplaySettings(stored)).toEqual({
      layout: DEFAULT_DIFF_DISPLAY_SETTINGS.layout,
      indicators: 'classic',
      showBackgrounds: false,
      showLineNumbers: DEFAULT_DIFF_DISPLAY_SETTINGS.showLineNumbers,
      wrapLines: DEFAULT_DIFF_DISPLAY_SETTINGS.wrapLines,
      inlineHighlight: DEFAULT_DIFF_DISPLAY_SETTINGS.inlineHighlight,
    });
  });

  test('a partial record fills in missing fields from the defaults', () => {
    const stored = JSON.stringify({ layout: 'unified' });
    expect(parseDiffDisplaySettings(stored)).toEqual({
      ...DEFAULT_DIFF_DISPLAY_SETTINGS,
      layout: 'unified',
    });
  });

  test('a payload missing wrapLines/inlineHighlight (an older build) falls back to defaults for them', () => {
    // What a build before these two settings existed would have persisted — a shape that's
    // incomplete rather than corrupt, and must not throw or drop the fields it does have.
    const stored = JSON.stringify({
      layout: 'split',
      indicators: 'bars',
      showBackgrounds: true,
      showLineNumbers: true,
    });
    expect(parseDiffDisplaySettings(stored)).toEqual(
      DEFAULT_DIFF_DISPLAY_SETTINGS
    );
  });

  test.each(['word-alt', 'word', 'char', 'none'] as const)(
    'a stored inlineHighlight of %s is honoured',
    (inlineHighlight) => {
      const stored = JSON.stringify({ inlineHighlight });
      expect(parseDiffDisplaySettings(stored).inlineHighlight).toBe(
        inlineHighlight
      );
    }
  );
});

describe('storage key', () => {
  test('is namespaced under the app prefix', () => {
    expect(DIFF_DISPLAY_STORAGE_KEY.startsWith('dispatch:')).toBe(true);
  });
});

describe('toDiffRenderOptions', () => {
  test('maps the defaults onto library options equal to omitting `options` entirely', () => {
    expect(toDiffRenderOptions(DEFAULT_DIFF_DISPLAY_SETTINGS)).toEqual({
      diffStyle: 'split',
      diffIndicators: 'bars',
      disableBackground: false,
      disableLineNumbers: false,
      overflow: 'scroll',
      lineDiffType: 'word-alt',
    });
  });

  test("inverts the show*/wrap settings into the library's disable*/overflow props", () => {
    expect(
      toDiffRenderOptions({
        layout: 'unified',
        indicators: 'none',
        showBackgrounds: false,
        showLineNumbers: false,
        wrapLines: true,
        inlineHighlight: 'none',
      })
    ).toEqual({
      diffStyle: 'unified',
      diffIndicators: 'none',
      disableBackground: true,
      disableLineNumbers: true,
      overflow: 'wrap',
      lineDiffType: 'none',
    });
  });
});
