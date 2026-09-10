import {
  RecommendationCard,
  type RecommendationCardAlternative,
} from '@/ui/ai/recommendation-card';
import type { GalleryStory } from '@/views/galleryStories';

const LOW_CONFIDENCE_ALTERNATIVES: RecommendationCardAlternative[] = [
  { id: 'retry-run', label: 'Retry the failed run on the same sandbox' },
  { id: 'reassign-agent', label: 'Reassign t-cafe27 to Claude instead' },
  { id: 'escalate', label: 'Escalate to Wyat for a manual boot fix' },
];

/** Gallery stories for Task 14 — Recommendation Card. Covers a high-confidence
 * accept-ready suggestion and a low-confidence one with alternatives pre-expanded. */
export const recommendationCardStories: GalleryStory[] = [
  {
    id: 'recommendation-card-high-confidence',
    title: 'Recommendation card — high confidence',
    note: 'Confidence meter fully filled with the accent color; alternatives collapsed by default.',
    render: () => (
      <RecommendationCard
        title="Merge the review queue reorder for apps/desktop?"
        rationale="e-f00b6d requested origin-first ordering before the queue lands — the diff is a small, isolated change to the merge scheduler with green CI."
        confidence={0.94}
        alternatives={[
          { id: 'hold-for-review', label: 'Hold for a second human review' },
        ]}
        onAccept={() => {}}
        onDismiss={() => {}}
        onPickAlternative={() => {}}
      />
    ),
  },
  {
    id: 'recommendation-card-low-confidence-expanded',
    title: 'Recommendation card — low confidence, alternatives expanded',
    note: 'Only two of five segments filled; the alternatives list starts open, each option pickable.',
    render: () => (
      <RecommendationCard
        title="Boot force-fail on t-cafe27 — rerun with a clean sandbox?"
        rationale="Two of the last four runs failed at boot with the same timeout, but the pattern doesn't match a known flake yet."
        confidence={0.32}
        alternatives={LOW_CONFIDENCE_ALTERNATIVES}
        defaultExpanded
        onAccept={() => {}}
        onDismiss={() => {}}
        onPickAlternative={() => {}}
      />
    ),
  },
];
