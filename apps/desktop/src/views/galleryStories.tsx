import type { ReactNode } from 'react';

import { LoadingState } from '@/ui/ai/loading-state';
import { Button } from '@/ui/button';

/** One reviewable primitive in the dev gallery: a title for the left index, an
 * optional caption, and the markup to render on the right. Every primitive task
 * (6-24) appends one or more of these — this file is the running catalog. */
export type GalleryStory = {
  id: string;
  title: string;
  note?: string;
  render: () => ReactNode;
};

export const galleryStories: GalleryStory[] = [
  {
    id: 'button-variants',
    title: 'Button variants',
    note: 'Existing shadcn Button — placeholder story proving the gallery scaffold before the Beautiful UI primitives land.',
    render: () => (
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="default">Default</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Destructive</Button>
        <Button variant="link">Link</Button>
      </div>
    ),
  },
  {
    id: 'loading-state-grid',
    title: 'Loading state — grid',
    note: 'Pixel-grid loader with shimmer label and live elapsed time, ticking from mount.',
    render: () => <LoadingState label="Provisioning sandbox" />,
  },
  {
    id: 'loading-state-orbit',
    title: 'Loading state — orbit',
    note: 'Three dots orbiting instead of the pixel grid.',
    render: () => <LoadingState label="Cloning repository" variant="orbit" />,
  },
  {
    id: 'loading-state-elapsed',
    title: 'Loading state — long-running',
    note: 'startedAt 90s in the past, showing the m:ss readout mid-count.',
    render: () => (
      <LoadingState
        label="Running agent Claude on task"
        startedAt={Date.now() - 90_000}
      />
    ),
  },
];
