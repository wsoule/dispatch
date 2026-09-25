import { useDiffDisplaySettings } from '../../hooks/useDiffDisplaySettings';
import type {
  DiffIndicatorStyle,
  DiffInlineHighlight,
  DiffLayout,
} from '../../lib/diffDisplay';
import { DiffSurface } from '../code/DiffSurface';
import { SettingsSearchable } from './search';
import { SettingsGroup, SettingsRow } from './SettingsGroup';
import { Switch } from '@/ui/ai/switch';
import { PanelRow } from '@/ui/chrome';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

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

/** How diffs render across Runs, Pull Requests, and the Git page. Backed by
 *  `useDiffDisplaySettings` (localStorage, per-browser) rather than
 *  `.dispatch/config.yml` — a viewing preference, not project configuration, so
 *  it has no save state and applies to every open diff surface immediately. */
export function DiffsSection() {
  const [settings, updateSettings] = useDiffDisplaySettings();

  return (
    <>
      <SettingsGroup
        title="Appearance"
        hint="Saved in this browser only. Nothing here changes the project."
        keywords="diff display"
        requires="none"
      >
        <SettingsRow
          title="Layout"
          control={
            <Select
              value={settings.layout}
              onValueChange={(layout) =>
                updateSettings({ layout: layout as DiffLayout })
              }
            >
              <SelectTrigger aria-label="Diff layout" className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIFF_LAYOUT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />

        <SettingsRow
          title="Change indicators"
          control={
            <Select
              value={settings.indicators}
              onValueChange={(indicators) =>
                updateSettings({ indicators: indicators as DiffIndicatorStyle })
              }
            >
              <SelectTrigger
                aria-label="Diff change indicators"
                className="w-[120px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIFF_INDICATOR_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />

        <SettingsRow
          title="Inline highlighting"
          control={
            <Select
              value={settings.inlineHighlight}
              onValueChange={(value) =>
                updateSettings({
                  inlineHighlight: value as DiffInlineHighlight,
                })
              }
            >
              <SelectTrigger
                aria-label="Inline highlighting"
                className="w-[120px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIFF_INLINE_HIGHLIGHT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />

        <SettingsRow
          title="Show backgrounds on changed lines"
          htmlFor="diff-show-backgrounds"
          control={
            <Switch
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
            <Switch
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
            <Switch
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
          <PanelRow className="p-3">
            {/* A fixed height with the surface as its own scroller: `CodeView` must be the
            element that scrolls (see `DiffSurface`'s `className` note), and the settings page
            should not grow by the length of the sample. */}
            <div className="border-border rounded-control flex h-72 min-h-0 w-full flex-col overflow-hidden border-[0.5px]">
              <DiffSurface
                patch={PREVIEW_PATCH}
                cacheKeyPrefix="settings-preview"
              />
            </div>
          </PanelRow>
        </SettingsSearchable>
      </SettingsGroup>
    </>
  );
}
