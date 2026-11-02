import { avatarHue, Chip } from '@dispatch/ui';
import { useSyncExternalStore } from 'react';

import {
  type LabelColors,
  labelColors,
  subscribeLabelColors,
} from '../../lib/labelColor';

/** One label as a Chip: its registry colour as a swatch, else a decorative hue from the
 * name. `data-slot="label-pill"` is the hook tests and e2e read. */
export function LabelChip({
  label,
  hex,
}: {
  label: string;
  hex: string | undefined;
}) {
  return hex === undefined ? (
    <Chip data-slot="label-pill" hue={avatarHue(label)}>
      {label}
    </Chip>
  ) : (
    <Chip data-slot="label-pill" mark={{ kind: 'swatch', color: hex }}>
      {label}
    </Chip>
  );
}

/**
 * The label registry's colours, re-read whenever the registry loads or changes, so a
 * component that draws label swatches (a `LabelChip`'s `hex`) repaints when the project's
 * `labels:` config arrives after the first render.
 */
export function useLabelColors(): LabelColors {
  return useSyncExternalStore(subscribeLabelColors, labelColors, labelColors);
}
