import { useState } from 'react';

import { InsightCard, type InsightDelta } from './insight-cards';
import type { GalleryStory } from '@/views/galleryStories';

type InsightPage = {
  title: string;
  summary: string;
  series: number[];
  unit: string;
  delta: InsightDelta;
};

// Two Dispatch fleet insights: runs/day trending up over the last two weeks, and
// merge lead time trending down — one green delta, one red, to exercise both tints.
const INSIGHT_PAGES: InsightPage[] = [
  {
    title: 'Runs per day are climbing',
    summary:
      'Across the fleet, agents kicked off more runs every day this week than last — Claude and Codex both picked up pace on the merge queue.',
    series: [14, 16, 15, 19, 22, 21, 26, 29],
    unit: 'runs',
    delta: { value: '+107%', direction: 'up' },
  },
  {
    title: 'Merge lead time is dropping',
    summary:
      'Median time from PR open to merge fell after origin-first ordering landed — the queue stops re-testing stale diffs against a moving base.',
    series: [58, 54, 49, 51, 40, 33, 28, 24],
    unit: 'min',
    delta: { value: '-59%', direction: 'down' },
  },
];

// InsightCard is fully controlled — same stateful-wrapper pattern the other paged
// demos in galleryStories.tsx use — so the pager dots actually flip pages.
function InsightCardsDemo() {
  const [page, setPage] = useState(0);
  const insight = INSIGHT_PAGES[page];
  if (!insight) return null;
  return (
    <InsightCard
      title={insight.title}
      summary={insight.summary}
      series={insight.series}
      unit={insight.unit}
      delta={insight.delta}
      page={page}
      pageCount={INSIGHT_PAGES.length}
      onPageChange={setPage}
    />
  );
}

/** Task 21's gallery stories, kept in this file rather than `galleryStories.tsx` per
 * the parallel-wave convention — the integration step folds these into the shared
 * catalog once every sibling primitive has landed. */
export const insightCardsStories: GalleryStory[] = [
  {
    id: 'insight-cards-paged',
    title: 'Insight cards — paged',
    note: 'Two-page fleet insight: runs/day trending up (green delta) and merge lead time trending down (red delta). Hover the chart for a scrub crosshair with a mono value bubble; click a pager dot to flip pages.',
    render: () => <InsightCardsDemo />,
  },
];
