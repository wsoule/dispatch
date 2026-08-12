import {
  FileCode2Icon,
  FileTextIcon,
  ReceiptTextIcon,
  TicketIcon,
} from 'lucide-react';

import { ContextCard, ContextCardRow } from './context-cards';
import type { GalleryStory } from '@/views/galleryStories';

/** Task 15's gallery stories, kept in this file rather than `galleryStories.tsx` per
 * the parallel-wave convention — the integration step folds these into the shared
 * catalog once every sibling primitive has landed. */
export const contextCardsStories: GalleryStory[] = [
  {
    id: 'context-cards-row',
    title: 'Context cards — row',
    note: 'Four retrieved chunks scrolling horizontally with fade masks at each edge: a repo doc, a config file, a ledger entry, and a Linear ticket.',
    render: () => (
      <ContextCardRow>
        <ContextCard
          icon={FileTextIcon}
          source="AGENTS.md"
          charCount={1842}
          snippet="Use bun for commands and dependency work. Do not use npm, pnpm, npx, or similar tools unless there is a specific reason. Dependencies use Bun's root workspaces.catalog."
          onOpen={() => {}}
        />
        <ContextCard
          icon={FileCode2Icon}
          source="tokens.css"
          charCount={614}
          snippet="--surface-inset: color-mix(in oklab, var(--surface) 92%, black 8%); --rounded-card: 10px; --shadow-hairline: 0 0 0 1px var(--border);"
          onOpen={() => {}}
        />
        <ContextCard
          icon={ReceiptTextIcon}
          source=".dispatch/ledger.jsonl:2461"
          charCount={356}
          snippet='{"kind":"decision","task":"t-2dfa1d","summary":"Surface all agents across repos in one view, grouped by run state"}'
          onOpen={() => {}}
        />
        <ContextCard
          icon={TicketIcon}
          source="LIN-1842"
          charCount={498}
          snippet="Boot force-fail must say why and surface the reason string on the run card instead of a bare failed badge with no context for the operator."
          onOpen={() => {}}
        />
      </ContextCardRow>
    ),
  },
];
