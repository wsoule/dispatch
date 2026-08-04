import type { FileDiffOptions } from '@pierre/diffs';

/** The two layouts `@pierre/diffs` can render a diff in. */
export type DiffLayout = 'split' | 'unified';

/** The three change-indicator styles `@pierre/diffs` supports on changed lines. */
export type DiffIndicatorStyle = 'bars' | 'classic' | 'none';

/**
 * The four levels of within-line highlighting `@pierre/diffs` can compute between a deleted and
 * an added line — `'word-alt'` is the library's own default (word-level, joining adjacent
 * changed words the way GitHub's "alt" mode does); `'word'`/`'char'` are coarser/finer
 * granularities; `'none'` turns it off.
 */
export type DiffInlineHighlight = 'word-alt' | 'word' | 'char' | 'none';

/**
 * The app's user-facing diff display preferences. Booleans are phrased as "show"/"wrap" rather
 * than mirroring `@pierre/diffs`' inverted `disable*` props (and its scroll-vs-wrap `overflow`
 * prop), so the Settings UI and its persisted shape read the way a user would describe them.
 */
export interface DiffDisplaySettings {
  layout: DiffLayout;
  indicators: DiffIndicatorStyle;
  showBackgrounds: boolean;
  showLineNumbers: boolean;
  wrapLines: boolean;
  inlineHighlight: DiffInlineHighlight;
}

// Matches every diff surface's behaviour before these settings existed — i.e. no `options` prop
// at all, which is exactly what `@pierre/diffs` itself defaults to. Confirmed against the built
// JS (the `.d.ts` doesn't encode defaults): `dist/renderers/DiffHunksRenderer.js` destructures
// `this.options` with `diffStyle = "split"`, `diffIndicators = "bars"`, `disableBackground =
// false`, `disableLineNumbers = false`, `overflow = "scroll"`, and `lineDiffType = "word-alt"`.
export const DEFAULT_DIFF_DISPLAY_SETTINGS: DiffDisplaySettings = {
  layout: 'split',
  indicators: 'bars',
  showBackgrounds: true,
  showLineNumbers: true,
  wrapLines: false,
  inlineHighlight: 'word-alt',
};

export const DIFF_DISPLAY_STORAGE_KEY = 'dispatch:diff-display-settings';

/**
 * Fired on `window` whenever `writeDiffDisplaySettings` persists a change, so every mounted diff
 * surface in this tab picks it up immediately. Plain `storage` events only fire in *other* tabs/
 * windows, never the one that made the write, so a same-window broadcast is the only way an open
 * diff updates without a remount.
 */
export const DIFF_DISPLAY_CHANGED_EVENT =
  'dispatch:diff-display-settings-changed';

function isDiffLayout(value: unknown): value is DiffLayout {
  return value === 'split' || value === 'unified';
}

function isDiffIndicatorStyle(value: unknown): value is DiffIndicatorStyle {
  return value === 'bars' || value === 'classic' || value === 'none';
}

function isDiffInlineHighlight(value: unknown): value is DiffInlineHighlight {
  return (
    value === 'word-alt' ||
    value === 'word' ||
    value === 'char' ||
    value === 'none'
  );
}

/**
 * Parses a stored diff-display preference, falling back to the default for a missing key,
 * invalid JSON, or a value with the wrong shape — field by field, so a partially-corrupt record
 * (e.g. an old build's payload missing a newer field) still keeps whatever it got right.
 */
export function parseDiffDisplaySettings(
  stored: string | null
): DiffDisplaySettings {
  if (stored === null) return DEFAULT_DIFF_DISPLAY_SETTINGS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return DEFAULT_DIFF_DISPLAY_SETTINGS;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return DEFAULT_DIFF_DISPLAY_SETTINGS;
  }
  const record = parsed as Record<string, unknown>;
  return {
    layout: isDiffLayout(record.layout)
      ? record.layout
      : DEFAULT_DIFF_DISPLAY_SETTINGS.layout,
    indicators: isDiffIndicatorStyle(record.indicators)
      ? record.indicators
      : DEFAULT_DIFF_DISPLAY_SETTINGS.indicators,
    showBackgrounds:
      typeof record.showBackgrounds === 'boolean'
        ? record.showBackgrounds
        : DEFAULT_DIFF_DISPLAY_SETTINGS.showBackgrounds,
    showLineNumbers:
      typeof record.showLineNumbers === 'boolean'
        ? record.showLineNumbers
        : DEFAULT_DIFF_DISPLAY_SETTINGS.showLineNumbers,
    wrapLines:
      typeof record.wrapLines === 'boolean'
        ? record.wrapLines
        : DEFAULT_DIFF_DISPLAY_SETTINGS.wrapLines,
    inlineHighlight: isDiffInlineHighlight(record.inlineHighlight)
      ? record.inlineHighlight
      : DEFAULT_DIFF_DISPLAY_SETTINGS.inlineHighlight,
  };
}

export function serializeDiffDisplaySettings(
  settings: DiffDisplaySettings
): string {
  return JSON.stringify(settings);
}

/**
 * Maps the app's "show X" / "wrap" settings onto the `@pierre/diffs` options object every diff
 * surface spreads into its `options` prop. Centralised here so the boolean inversion (`show*` ->
 * `disable*`) and the `wrapLines` -> `overflow` translation happen once rather than at each of
 * the three call sites.
 */
export function toDiffRenderOptions(
  settings: DiffDisplaySettings
): Pick<
  FileDiffOptions<unknown>,
  | 'diffStyle'
  | 'diffIndicators'
  | 'disableBackground'
  | 'disableLineNumbers'
  | 'overflow'
  | 'lineDiffType'
> {
  return {
    diffStyle: settings.layout,
    diffIndicators: settings.indicators,
    disableBackground: !settings.showBackgrounds,
    disableLineNumbers: !settings.showLineNumbers,
    overflow: settings.wrapLines ? 'wrap' : 'scroll',
    lineDiffType: settings.inlineHighlight,
  };
}
