import { render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { galleryStories } from './galleryStories';
import { GalleryView } from './GalleryView';

// The gallery's whole job is to surface every registered story — this pins that down so a
// future primitive task that appends to `galleryStories` but forgets to render it fails loudly.
test('renders every story title, in both the index and the story section', () => {
  render(<GalleryView />);

  for (const story of galleryStories) {
    expect(screen.getAllByText(story.title).length).toBeGreaterThanOrEqual(2);
  }
});

test('the header reports the story count', () => {
  render(<GalleryView />);

  expect(
    screen.getByText(
      `${galleryStories.length} ${galleryStories.length === 1 ? 'primitive' : 'primitives'}`
    )
  ).toBeDefined();
});
