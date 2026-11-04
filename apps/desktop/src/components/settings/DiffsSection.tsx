import { Select } from '@dispatch/ui';

import { useDiffDisplaySettings } from '../../hooks/useDiffDisplaySettings';
import type {
  DiffIndicatorStyle,
  DiffInlineHighlight,
  DiffLayout,
} from '../../lib/diffDisplay';
import { DiffSurface } from '../code/DiffSurface';
import styles from './DiffsSection.module.css';
import { SettingsSwitch } from './fields';
import { SettingsSearchable } from './search';
import kit from './settings.module.css';
import { SettingsGroup, SettingsRow } from './SettingsGroup';

/** The option of `options` whose value is `value`, or undefined. */
function pick<T extends string>(
  options: readonly { value: T }[],
  value: string
): T | undefined {
  return options.find((option) => option.value === value)?.value;
}

const DIFF_LAYOUT_OPTIONS: { value: DiffLayout; label: string }[] = [
  { value: 'split', label: 'Split' },
  { value: 'unified', label: 'Unified' },
];

const DIFF_INDICATOR_OPTIONS: { value: DiffIndicatorStyle; label: string }[] = [
  { value: 'bars', label: 'Bars' },
  { value: 'classic', label: 'Classic' },
  { value: 'none', label: 'None' },
];

// Human names for `lineDiffType`, not the raw prop values.
const DIFF_INLINE_HIGHLIGHT_OPTIONS: {
  value: DiffInlineHighlight;
  label: string;
}[] = [
  { value: 'word-alt', label: 'Word (alt)' },
  { value: 'word', label: 'Word' },
  { value: 'char', label: 'Character' },
  { value: 'none', label: 'None' },
];

// What the preview renders: one small file with a changed line, an added block and a
// removed one, so every setting above has something visible to act on — the inline
// highlight needs a line that changed in place, the indicators need an add and a delete.
const PREVIEW_PATCH = `diff --git a/src/cart.ts b/src/cart.ts
index 3f1a2b4..9c8d7e6 100644
--- a/src/cart.ts
+++ b/src/cart.ts
@@ -1,12 +1,16 @@
 import { price } from './price';
 
 export interface CartItem {
   sku: string;
   cents: number;
+  quantity: number;
 }
 
-export function total(items: CartItem[]): number {
-  return items.reduce((sum, item) => sum + item.cents, 0);
+export function total(items: CartItem[], coupon?: number): number {
+  const subtotal = items.reduce(
+    (sum, item) => sum + item.cents * item.quantity,
+    0
+  );
+  return coupon === undefined ? subtotal : subtotal - coupon;
 }
 
 export function label(items: CartItem[]): string {
-  return price(total(items));
+  return \`\${items.length} items · \${price(total(items))}\`;
 }
`;

// What a split setting does in a review: the review page's diff column sits beside the
// checklist and the properties rail, and in most windows it is too narrow for two readable
// sides (useFittedDiffLayout's SPLIT_MIN_WIDTH), so it draws unified there. Said in words a
// person can check against their own window rather than as a pixel width they cannot see.
const REVIEW_LAYOUT_NOTE =
  'Review diffs show unified while their column is too narrow for two sides, which it is in most windows.';

/** How diffs render across Runs, Pull Requests, and the Git page. Backed by
 *  `useDiffDisplaySettings` (localStorage, per-browser) rather than
 *  `.dispatch/config.yml` — a viewing preference, not project configuration, so
 *  it has no save state and applies to every open diff surface immediately. */
export function DiffsSection() {
  const [settings, updateSettings] = useDiffDisplaySettings();

  return (
    <>
      <SettingsGroup
        title="Diff appearance"
        hint="Saved in this browser only. Nothing here changes the project."
        keywords="diff display"
        requires="none"
      >
        <SettingsRow
          title="Layout"
          subtitle={REVIEW_LAYOUT_NOTE}
          control={
            <Select
              label="Diff layout"
              value={settings.layout}
              options={DIFF_LAYOUT_OPTIONS}
              className={styles.select}
              onChange={(value) => {
                const next = pick(DIFF_LAYOUT_OPTIONS, value);
                if (next !== undefined) updateSettings({ layout: next });
              }}
            />
          }
        />

        <SettingsRow
          title="Change indicators"
          control={
            <Select
              label="Diff change indicators"
              value={settings.indicators}
              options={DIFF_INDICATOR_OPTIONS}
              className={styles.select}
              onChange={(value) => {
                const next = pick(DIFF_INDICATOR_OPTIONS, value);
                if (next !== undefined) updateSettings({ indicators: next });
              }}
            />
          }
        />

        <SettingsRow
          title="Inline highlighting"
          control={
            <Select
              label="Inline highlighting"
              value={settings.inlineHighlight}
              options={DIFF_INLINE_HIGHLIGHT_OPTIONS}
              className={styles.select}
              onChange={(value) => {
                const next = pick(DIFF_INLINE_HIGHLIGHT_OPTIONS, value);
                if (next !== undefined)
                  updateSettings({ inlineHighlight: next });
              }}
            />
          }
        />

        <SettingsRow
          title="Show backgrounds on changed lines"
          htmlFor="diff-show-backgrounds"
          control={
            <SettingsSwitch
              id="diff-show-backgrounds"
              checked={settings.showBackgrounds}
              onCheckedChange={(checked) =>
                updateSettings({ showBackgrounds: checked })
              }
            />
          }
        />

        <SettingsRow
          title="Show line numbers"
          htmlFor="diff-show-line-numbers"
          control={
            <SettingsSwitch
              id="diff-show-line-numbers"
              checked={settings.showLineNumbers}
              onCheckedChange={(checked) =>
                updateSettings({ showLineNumbers: checked })
              }
            />
          }
        />

        <SettingsRow
          title="Wrap long lines"
          htmlFor="diff-wrap-lines"
          control={
            <SettingsSwitch
              id="diff-wrap-lines"
              checked={settings.wrapLines}
              onCheckedChange={(checked) =>
                updateSettings({ wrapLines: checked })
              }
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup
        title="Preview"
        hint="Every diff in the app looks like this: runs, pull requests and the Git page."
        keywords="diff sample"
        requires="none"
      >
        <SettingsSearchable text="diff preview sample">
          <div className={kit.row}>
            {/* A fixed height with the surface as its own scroller: `CodeView` must be the
            element that scrolls (see `DiffSurface`'s `className` note), and the settings page
            should not grow by the length of the sample. */}
            <div className={styles.preview}>
              <DiffSurface
                patch={PREVIEW_PATCH}
                cacheKeyPrefix="settings-preview"
              />
            </div>
          </div>
        </SettingsSearchable>
      </SettingsGroup>
    </>
  );
}
