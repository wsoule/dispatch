import { CopyIcon, RotateCcwIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { LoadingState } from '@/ui/ai/loading-state';
import {
  StreamingText,
  type StreamingTextSource,
} from '@/ui/ai/streaming-text';
import { Thinking, type ThinkingStep } from '@/ui/ai/thinking';
import { Button } from '@/ui/button';

// `Thinking` is fully controlled (collapsed/onToggle live with the caller), so its
// gallery stories need a small stateful wrapper to make the chevron toggle work —
// unlike the other stateless primitives above, `render()` alone can't hold state.
const COLLAPSED_ACTIVE_STEPS: ThinkingStep[] = [
  {
    kind: 'reasoning',
    label: 'Reviewing the failing run diff on t-cafe27',
    state: 'active',
  },
];

function ThinkingCollapsedActiveDemo() {
  const [collapsed, setCollapsed] = useState(true);
  return (
    <Thinking
      steps={COLLAPSED_ACTIVE_STEPS}
      collapsed={collapsed}
      onToggle={() => setCollapsed((current) => !current)}
      elapsedLabel="0:04"
    />
  );
}

const MIXED_STATE_STEPS: ThinkingStep[] = [
  {
    kind: 'reasoning',
    label: 'Reviewing task-cafe27 acceptance criteria',
    detail: 'Boot force-fail must surface a reason string on the run card.',
    state: 'done',
  },
  {
    kind: 'search',
    label: 'Searching prior boot-fail runs in dispatchd for the same repo',
    state: 'active',
  },
  {
    kind: 'coding',
    label: 'Patch dispatchd/src/boot.rs',
    state: 'pending',
  },
];

function ThinkingExpandedMixedDemo() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <Thinking
      steps={MIXED_STATE_STEPS}
      collapsed={collapsed}
      onToggle={() => setCollapsed((current) => !current)}
      elapsedLabel="0:12"
    />
  );
}

const STREAMING_ANSWER =
  'Across the last 30 runs, apps/desktop/src/server tests failed intermittently in 4 of them — all timing-sensitive assertions around WebSocket reconnects. packages/core stayed green the whole window.';

const STREAMING_SOURCES: StreamingTextSource[] = [
  { id: 'run-a91f', label: 'Run a91f — apps/desktop', href: '#' },
  { id: 'run-c204', label: 'Run c204 — apps/desktop', href: '#' },
  { id: 'flaky-doc', label: 'flaky-timing-tests.md' },
];

const STREAMING_FOLLOW_UPS = [
  'Show me the four flaky runs on apps/desktop',
  'Which assertion keeps timing out',
];

// Actions row: copy the answer or re-run the streamed reply. Icon-only buttons matching
// the showcase's compact toolbar, styled with real Dispatch tokens.
function StreamingActions() {
  return (
    <>
      <button
        type="button"
        aria-label="Copy answer"
        className="text-muted-foreground hover:bg-surface-hover-strong hover:text-foreground flex size-6 items-center justify-center rounded-[6px] transition-colors duration-100"
      >
        <CopyIcon aria-hidden className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label="Regenerate answer"
        className="text-muted-foreground hover:bg-surface-hover-strong hover:text-foreground flex size-6 items-center justify-center rounded-[6px] transition-colors duration-100"
      >
        <RotateCcwIcon aria-hidden className="size-3.5" />
      </button>
    </>
  );
}

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
  {
    id: 'thinking-collapsed-active',
    title: 'Thinking — collapsed, active',
    note: 'Muted chip with a shimmering label while the agent is still reasoning; click to expand.',
    render: () => <ThinkingCollapsedActiveDemo />,
  },
  {
    id: 'thinking-expanded-mixed',
    title: 'Thinking — expanded, mixed state',
    note: 'Reasoning done, search active (shimmering), coding still pending — connecting hairline down the left rail.',
    render: () => <ThinkingExpandedMixedDemo />,
  },
  {
    id: 'streaming-text-mid-stream',
    title: 'Streaming text — mid-stream',
    note: 'Word-boundary-aware typing reveal with a blinking caret; sources and follow-ups stay hidden until the answer finishes.',
    render: () => <StreamingText text={STREAMING_ANSWER} streaming />,
  },
  {
    id: 'streaming-text-complete',
    title: 'Streaming text — complete, with sources and follow-ups',
    note: 'Reveal finished: caret gone, copy/regenerate actions, numbered source chips, and follow-up suggestions all visible.',
    render: () => (
      <StreamingText
        text={STREAMING_ANSWER}
        streaming={false}
        sources={STREAMING_SOURCES}
        followUps={STREAMING_FOLLOW_UPS}
        onFollowUp={() => {}}
        actions={<StreamingActions />}
      />
    ),
  },
];
