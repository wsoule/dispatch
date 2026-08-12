import { useState } from 'react';

import { FineTuneCard, type FineTuneCardControl } from './fine-tune-card';
import type { GalleryStory } from '@/views/galleryStories';

// The showcase's exact four controls, re-themed as knobs for how a task card
// renders on Dispatch's kanban board: arrangement, corner radius, opacity,
// and card style.
const INITIAL_CONTROLS: FineTuneCardControl[] = [
  {
    id: 'layout',
    label: 'Layout',
    kind: 'segmented',
    options: ['row', 'column', 'grid'],
    value: 'row',
  },
  {
    id: 'radius',
    label: 'Radius',
    kind: 'slider',
    min: 0,
    max: 24,
    value: 10,
  },
  {
    id: 'opacity',
    label: 'Opacity',
    kind: 'slider',
    min: 0,
    max: 100,
    value: 100,
    unit: '%',
  },
  {
    id: 'type',
    label: 'Type',
    kind: 'select',
    options: ['solid', 'outline', 'ghost'],
    value: 'solid',
  },
];

// Applies a single control's new value onto the controls array by id, keeping
// every other control's shape (kind/options/etc.) untouched.
function applyControlChange(
  controls: FineTuneCardControl[],
  id: string,
  value: string | number
): FineTuneCardControl[] {
  return controls.map((control) => {
    if (control.id !== id) return control;
    if (control.kind === 'slider' && typeof value === 'number') {
      return { ...control, value };
    }
    if (control.kind !== 'slider' && typeof value === 'string') {
      return { ...control, value };
    }
    return control;
  });
}

// Wires FineTuneCard's controlled controls up to local state so gallery
// clicks/drags actually move the segmented picker, slider, and select.
function FineTuneCardDemo({
  title,
  initialControls,
}: {
  title: string;
  initialControls: FineTuneCardControl[];
}) {
  const [controls, setControls] = useState(initialControls);

  return (
    <FineTuneCard
      title={title}
      controls={controls}
      onChange={(id, value) =>
        setControls((current) => applyControlChange(current, id, value))
      }
    />
  );
}

export const fineTuneCardStories: GalleryStory[] = [
  {
    id: 'fine-tune-card-task-card-style',
    title: 'Fine-tune card — task card style',
    note: 'Inspector for a kanban task card: a row/column/grid segmented layout picker, radius and opacity sliders with mono value readouts, and a card-style select. Every control is interactive and controlled by the demo’s local state.',
    render: () => (
      <FineTuneCardDemo
        title="Task card style"
        initialControls={INITIAL_CONTROLS}
      />
    ),
  },
];
