import type { ReactNode } from 'react';

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
];
