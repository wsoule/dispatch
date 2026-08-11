import {
  CopyIcon,
  FileTextIcon,
  PencilIcon,
  RotateCcwIcon,
  TerminalIcon,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { ApprovalCard, type ApprovalCardOption } from '@/ui/ai/approval-card';
import { LoadingState } from '@/ui/ai/loading-state';
import {
  StreamingText,
  type StreamingTextSource,
} from '@/ui/ai/streaming-text';
import { Thinking, type ThinkingStep } from '@/ui/ai/thinking';
import { ToolChip, ToolChipGroup } from '@/ui/ai/tool-chips';
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

const SCOPE_OPTIONS: ApprovalCardOption[] = [
  {
    id: 'once',
    label: 'Allow apps/desktop/src/server for this call only',
    description:
      'One-time grant — the next write outside the fence asks again.',
  },
  {
    id: 'session',
    label: 'Allow apps/desktop/src/server for the rest of this run',
    description: 'Covers every remaining tool call in run c204.',
    recommended: true,
  },
  {
    id: 'deny',
    label: 'Deny and keep the agent inside its declared fence',
  },
];

// `ApprovalCard` is fully controlled, so the "unanswered" and "selected" gallery stories
// each need a small stateful wrapper to make clicking an option actually select it —
// same pattern as the Thinking demos above.
function ApprovalCardScopeDemo() {
  const [selectedId, setSelectedId] = useState<string | undefined>();
  return (
    <ApprovalCard
      question="The agent wants to edit outside its declared fence"
      detail="apps/desktop/src/server isn't in task t-716d89's scope."
      options={SCOPE_OPTIONS}
      selectedId={selectedId}
      onSelect={setSelectedId}
    />
  );
}

const PLAN_OPTIONS: ApprovalCardOption[] = [
  {
    id: 'kanban-columns',
    label: 'Rework the kanban columns first',
    description:
      'Matches the "UI needs to be a bit" task — highest-visibility surface.',
    recommended: true,
  },
  {
    id: 'boot-fail',
    label: 'Fix boot force-fail messaging first',
    description: 'Smaller, self-contained; unblocks t-cafe27 sooner.',
  },
  {
    id: 'agents-view',
    label: 'Build the all-agents view first',
  },
];

function ApprovalCardPlanDemo() {
  const [selectedId, setSelectedId] = useState<string | undefined>(
    'kanban-columns'
  );
  return (
    <ApprovalCard
      question="Which task should I pick up next?"
      options={PLAN_OPTIONS}
      selectedId={selectedId}
      onSelect={setSelectedId}
    />
  );
}

const ANSWERED_OPTIONS: ApprovalCardOption[] = [
  { id: 'approve', label: 'Approve the merge queue reorder' },
  { id: 'deny', label: 'Deny — keep origin-first ordering' },
];

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
  {
    id: 'approval-card-unanswered',
    title: 'Approval card — scope request, unanswered',
    note: 'Radio-style option rows with hover; the "session" grant is flagged Recommended. Click an option to select it.',
    render: () => <ApprovalCardScopeDemo />,
  },
  {
    id: 'approval-card-selected',
    title: 'Approval card — plan question, selected',
    note: 'One option pre-selected — accent-tint wash, selected-border ring, and the confirm row at the bottom.',
    render: () => <ApprovalCardPlanDemo />,
  },
  {
    id: 'approval-card-disabled',
    title: 'Approval card — disabled, answered',
    note: 'A decision already landed: options are inert (disabled) and the footer reads "Answered".',
    render: () => (
      <ApprovalCard
        question="Approve the merge queue reorder for apps/desktop?"
        detail="e-f00b6d requested origin-first ordering before the queue lands."
        options={ANSWERED_OPTIONS}
        selectedId="approve"
        disabled
        onSelect={() => {}}
      />
    ),
  },
  {
    id: 'tool-chips-mixed-state',
    title: 'Tool chips — mixed state, with overflow',
    note: 'Edit and Bash done with diff/exit-code meta, Read still running (shimmering label), a failed Bash chip in red, and a "+3" overflow chip for the rest of the run.',
    render: () => (
      <ToolChipGroup overflowCount={3}>
        <ToolChip
          icon={PencilIcon}
          label="Edit"
          meta={
            <>
              <span className="text-green">+24</span>{' '}
              <span className="text-red">−3</span>
            </>
          }
          state="done"
        />
        <ToolChip icon={TerminalIcon} label="bun test" state="done" />
        <ToolChip
          icon={FileTextIcon}
          label="Read"
          meta="AGENTS.md"
          state="running"
        />
        <ToolChip
          icon={TerminalIcon}
          label="bun run tsc"
          meta="exit 1"
          state="failed"
        />
      </ToolChipGroup>
    ),
  },
];
