import { useDiffDisplaySettings } from '../../hooks/useDiffDisplaySettings';
import type {
  DiffIndicatorStyle,
  DiffInlineHighlight,
  DiffLayout,
} from '../../lib/diffDisplay';
import { HintText, Panel, PanelHeader, PanelRow } from '@/ui/chrome';
import type { SegmentedOption } from '@/ui/chrome/Segmented';
import { Segmented } from '@/ui/chrome/Segmented';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

const DIFF_LAYOUT_OPTIONS: SegmentedOption<DiffLayout>[] = [
  { value: 'split', label: 'Split' },
  { value: 'unified', label: 'Unified' },
];

const DIFF_INDICATOR_OPTIONS: SegmentedOption<DiffIndicatorStyle>[] = [
  { value: 'bars', label: 'Bars' },
  { value: 'classic', label: 'Classic' },
  { value: 'none', label: 'None' },
];

// Human names for `lineDiffType`, not the raw prop values — four options is one too many for a
// comfortable `Segmented` row at narrow widths, so this renders as a `Select` instead.
const DIFF_INLINE_HIGHLIGHT_OPTIONS: {
  value: DiffInlineHighlight;
  label: string;
}[] = [
  { value: 'word-alt', label: 'Word (alt)' },
  { value: 'word', label: 'Word' },
  { value: 'char', label: 'Character' },
  { value: 'none', label: 'None' },
];

/** How diffs render across Runs, Pull Requests, and the Git page. Backed by
 *  `useDiffDisplaySettings` (localStorage, per-browser) rather than
 *  `.dispatch/config.yml` — a viewing preference, not project configuration, so
 *  it has no save state and applies to every open diff surface immediately. */
export function DiffsSection() {
  const [settings, updateSettings] = useDiffDisplaySettings();

  return (
    <Panel>
      <PanelHeader>Diffs</PanelHeader>

      <PanelRow>
        <HintText>
          Stored in this browser, not .dispatch/config.yml — a display
          preference rather than project configuration.
        </HintText>
      </PanelRow>

      <PanelRow>
        <label className="flex items-center gap-3">
          <span className="w-40 flex-shrink-0 text-[13px]">Layout</span>
          <Segmented
            value={settings.layout}
            onChange={(layout) => updateSettings({ layout })}
            options={DIFF_LAYOUT_OPTIONS}
            label="Diff layout"
          />
        </label>
      </PanelRow>

      <PanelRow>
        <label className="flex items-center gap-3">
          <span className="w-40 flex-shrink-0 text-[13px]">
            Change indicators
          </span>
          <Segmented
            value={settings.indicators}
            onChange={(indicators) => updateSettings({ indicators })}
            options={DIFF_INDICATOR_OPTIONS}
            label="Diff change indicators"
          />
        </label>
      </PanelRow>

      <PanelRow>
        <label className="flex items-center gap-3">
          <span className="w-40 flex-shrink-0 text-[13px]">
            Inline highlighting
          </span>
          <Select
            value={settings.inlineHighlight}
            onValueChange={(value) =>
              updateSettings({
                inlineHighlight: value as DiffInlineHighlight,
              })
            }
          >
            <SelectTrigger
              size="sm"
              aria-label="Inline highlighting"
              className="w-[160px] text-[12px]"
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
        </label>
      </PanelRow>

      <PanelRow>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.showBackgrounds}
            onChange={(e) =>
              updateSettings({ showBackgrounds: e.target.checked })
            }
            className="accent-accent size-3.5"
          />
          <span className="text-[13px]">Show backgrounds on changed lines</span>
        </label>
      </PanelRow>

      <PanelRow>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.showLineNumbers}
            onChange={(e) =>
              updateSettings({ showLineNumbers: e.target.checked })
            }
            className="accent-accent size-3.5"
          />
          <span className="text-[13px]">Show line numbers</span>
        </label>
      </PanelRow>

      <PanelRow>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.wrapLines}
            onChange={(e) => updateSettings({ wrapLines: e.target.checked })}
            className="accent-accent size-3.5"
          />
          <span className="text-[13px]">Wrap long lines</span>
        </label>
      </PanelRow>
    </Panel>
  );
}
