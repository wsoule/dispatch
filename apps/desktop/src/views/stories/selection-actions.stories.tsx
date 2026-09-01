import { useEffect, useRef, useState } from 'react';

import {
  defaultSelectionActions,
  SelectionActionsMenu,
} from '@/ui/ai/selection-actions';
import type { GalleryStory } from '@/views/galleryStories';

// Real selections aren't reproducible in a static story, so this measures an actual
// highlighted span's `getBoundingClientRect()` after mount — the same rect shape
// `useTextSelection` would hand a caller — rather than guessing pixel coordinates by hand.
function SelectionActionsDemo({ openTone = false }: { openTone?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const spanRef = useRef<HTMLSpanElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (spanRef.current) setRect(spanRef.current.getBoundingClientRect());
  }, []);

  useEffect(() => {
    if (!openTone || !rect || !containerRef.current) return;
    // Drives the menu into its submenu state through a real click, the same path a
    // reviewer's mouse takes — there's no prop for forcing the submenu open.
    const toneButton = Array.from(
      containerRef.current.querySelectorAll('button')
    ).find((button) => button.textContent?.includes('Tone'));
    toneButton?.click();
    // Only once, right after the rect (and the menu it gates) first render.
  }, [openTone, rect]);

  return (
    <div ref={containerRef} className="mx-auto w-full max-w-[26rem] pt-16 pb-4">
      <p className="text-foreground text-[13px] leading-relaxed">
        Pistachio holds the top slot all weekend.{' '}
        <span
          ref={spanRef}
          className="bg-accent-tint rounded-[3px] box-decoration-clone"
        >
          Churn it first thing Saturday so the batch has time to firm up before
          the afternoon rush.
        </span>
      </p>
      {rect && (
        <SelectionActionsMenu
          actions={defaultSelectionActions}
          onAction={() => {}}
          position={rect}
        />
      )}
    </div>
  );
}

/** Task 24's gallery stories, kept in this file rather than `galleryStories.tsx` per the
 * parallel-wave convention — the integration step folds these into the shared catalog once
 * every sibling primitive has landed. */
export const selectionActionsStories: GalleryStory[] = [
  {
    id: 'selection-actions-menu',
    title: 'Selection actions',
    note: 'Highlight a passage and hand it to the agent to rewrite — a floating chip row of Explain/Improve/Shorten/Tone/Grammar above the selected text.',
    render: () => <SelectionActionsDemo />,
  },
  {
    id: 'selection-actions-tone-submenu',
    title: 'Selection actions — Tone submenu',
    note: 'Picking Tone swaps the row for Professional/Friendly/Direct instead of firing immediately; a back chevron returns to the top-level actions.',
    render: () => <SelectionActionsDemo openTone />,
  },
];
