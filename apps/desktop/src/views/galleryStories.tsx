import {
  ArrowUpIcon,
  CopyIcon,
  EyeIcon,
  FileTextIcon,
  GitBranchIcon,
  PencilIcon,
  RotateCcwIcon,
  SparklesIcon,
  SquareIcon,
  TerminalIcon,
  XIcon,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { codeBlockStories } from './stories/code-block.stories';
import { contextCardsStories } from './stories/context-cards.stories';
import { diffTableStories } from './stories/diff-table.stories';
import { filterTableStories } from './stories/filter-table.stories';
import { fineTuneCardStories } from './stories/fine-tune-card.stories';
import { insightCardsStories } from './stories/insight-cards.stories';
import { recommendationCardStories } from './stories/recommendation-card.stories';
import { recordsTableStories } from './stories/records-table.stories';
import { searchStories } from './stories/search.stories';
import { selectionActionsStories } from './stories/selection-actions.stories';
import { sidebarNavStories } from './stories/sidebar-nav.stories';
import { ApprovalCard, type ApprovalCardOption } from '@/ui/ai/approval-card';
import {
  ChatMessage,
  type ChatMessageProps,
  ChatPanel,
  type ChatTab,
} from '@/ui/ai/chat';
import { LoadingState } from '@/ui/ai/loading-state';
import {
  PromptBar,
  type PromptBarCommand,
  type PromptBarModel,
  type PromptBarReference,
} from '@/ui/ai/prompt-bar';
import {
  StreamingText,
  type StreamingTextSource,
} from '@/ui/ai/streaming-text';
import { TaskRow, TaskRowList } from '@/ui/ai/task-rows';
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

// Compact icon button for a TaskRow's hover-revealed `actions` slot — the same
// treatment the showcase uses for its "copy code" / "view code" corner buttons.
function TaskRowActionButton({
  icon: Icon,
  label,
}: {
  icon: typeof EyeIcon;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(event) => event.stopPropagation()}
      className="text-muted-foreground hover:bg-surface-hover-strong hover:text-foreground rounded-control flex size-6 items-center justify-center transition-colors duration-100"
    >
      <Icon aria-hidden className="size-3.5" />
    </button>
  );
}

const CHAT_TABS: ChatTab[] = [
  { id: 'kanban', label: 'Kanban rework' },
  { id: 'boot-fail', label: 'Boot force-fail', unread: true },
];

const CHAT_AGENT_AVATAR = (
  <span className="bg-accent-tint text-primary flex size-6 items-center justify-center rounded-full">
    <SparklesIcon aria-hidden className="size-3.5" />
  </span>
);

// Mock transcript for the two-tab story. Read from a data array (rather than
// literal `role="user"`/`role="agent"` JSX props) so each role comes from a typed
// field, the same shape `WardenView`/`PlansView` already pass through to their own
// message rows.
const CHAT_MESSAGES: Array<{
  id: string;
  role: ChatMessageProps['role'];
  text: string;
  avatar?: ReactNode;
}> = [
  {
    id: 'm1',
    role: 'user',
    text: 'Rework the kanban columns to match the new spacing scale',
  },
  {
    id: 'm2',
    role: 'agent',
    text: 'Reworked the column gutters and card padding on t-716d89 — columns now use the 8px scale end to end.',
    avatar: CHAT_AGENT_AVATAR,
  },
  {
    id: 'm3',
    role: 'user',
    text: 'Does the boot force-fail task block this?',
  },
  {
    id: 'm4',
    role: 'agent',
    text: "No — t-cafe27 touches dispatchd's boot path only, no overlap with the kanban view.",
  },
];

// Static stand-in for PromptBar (Task 13) — same field footprint as the showcase's
// composer so ChatPanel's bottom slot reads correctly before the real input lands.
function ComposerPlaceholder() {
  return (
    <div className="rounded-control border-border bg-field flex flex-col gap-2 border p-2.5">
      <span className="text-muted-foreground text-[13px]">
        Message the agent…
      </span>
      <div className="flex items-center justify-end">
        <button
          type="button"
          aria-label="Send"
          disabled
          className="text-muted-foreground flex size-7 items-center justify-center rounded-[8px] bg-[var(--border-strong)]"
        >
          <ArrowUpIcon aria-hidden className="size-4" />
        </button>
      </div>
    </div>
  );
}

// `ChatPanel` is fully controlled, so the gallery story needs a small stateful
// wrapper to make clicking a tab actually switch it — same pattern as the Thinking
// and ApprovalCard demos above.
function ChatPanelDemo() {
  const [activeTabId, setActiveTabId] = useState('kanban');
  return (
    <div className="h-90 w-95">
      <ChatPanel
        tabs={CHAT_TABS}
        activeTabId={activeTabId}
        onSelectTab={setActiveTabId}
        onNewTab={() => {}}
        composer={<ComposerPlaceholder />}
      >
        {CHAT_MESSAGES.map((message) => (
          <ChatMessage
            key={message.id}
            role={message.role}
            avatar={message.avatar}
          >
            {message.text}
          </ChatMessage>
        ))}
      </ChatPanel>
    </div>
  );
}

const PROMPT_BAR_MODELS: PromptBarModel[] = [
  { id: 'sonnet-5', label: 'Sonnet 5' },
  { id: 'opus-5', label: 'Opus 5' },
  { id: 'haiku-5', label: 'Haiku 5' },
];

const PROMPT_BAR_COMMANDS: PromptBarCommand[] = [
  { id: 'retry', label: 'Retry', hint: 'Re-run the last agent turn' },
  { id: 'review', label: 'Review', hint: 'Request a code review' },
  { id: 'redirect', label: 'Redirect', hint: 'Steer the agent mid-run' },
  { id: 'explain', label: 'Explain', hint: 'Explain the current diff' },
];

// `PromptBar` is fully controlled — same pattern as ChatPanelDemo above — so each
// gallery story owns its own value/model/reference state.
function PromptBarEmptyDemo() {
  const [value, setValue] = useState('');
  const [modelId, setModelId] = useState('sonnet-5');
  return (
    <div className="w-95">
      <PromptBar
        value={value}
        onChange={setValue}
        onSubmit={() => {}}
        models={PROMPT_BAR_MODELS}
        modelId={modelId}
        onModelChange={setModelId}
        commands={PROMPT_BAR_COMMANDS}
      />
    </div>
  );
}

function PromptBarWithReferencesDemo() {
  const [value, setValue] = useState(
    'Patch the WebSocket reconnect suite before merging'
  );
  const [modelId, setModelId] = useState('opus-5');
  const [references, setReferences] = useState<PromptBarReference[]>([
    {
      id: 'boot-rs',
      label: 'dispatchd/src/boot.rs',
      icon: <FileTextIcon aria-hidden className="size-3" />,
    },
    {
      id: 'agents-md',
      label: 'AGENTS.md',
      icon: <FileTextIcon aria-hidden className="size-3" />,
    },
    {
      id: 'branch',
      label: 't-cafe27-boot-force-fail',
      icon: <GitBranchIcon aria-hidden className="size-3" />,
    },
  ]);
  return (
    <div className="w-95">
      <PromptBar
        value={value}
        onChange={setValue}
        onSubmit={() => {}}
        references={references}
        onRemoveReference={(id) =>
          setReferences((prev) => prev.filter((ref) => ref.id !== id))
        }
        models={PROMPT_BAR_MODELS}
        modelId={modelId}
        onModelChange={setModelId}
        commands={PROMPT_BAR_COMMANDS}
      />
    </div>
  );
}

function PromptBarCommandPopoverDemo() {
  const [value, setValue] = useState('/re');
  const [modelId, setModelId] = useState('sonnet-5');
  return (
    <div className="w-95">
      <PromptBar
        value={value}
        onChange={setValue}
        onSubmit={() => {}}
        models={PROMPT_BAR_MODELS}
        modelId={modelId}
        onModelChange={setModelId}
        commands={PROMPT_BAR_COMMANDS}
      />
    </div>
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
  {
    id: 'task-rows-all-states',
    title: 'Task rows — all states',
    note: 'One TaskRowList covering running (pulsing dot, shimmering detail), waiting, failed (red wash), done, and queued — hover a row to reveal its actions.',
    render: () => (
      <TaskRowList>
        <TaskRow
          title="Patch dispatchd/src/boot.rs"
          agent="Claude"
          state="running"
          detail="Reading boot.rs to trace the failing assertion"
          progress="2/5 files"
          elapsedLabel="1:42"
          onClick={() => {}}
          actions={
            <>
              <TaskRowActionButton icon={EyeIcon} label="Open run" />
              <TaskRowActionButton icon={SquareIcon} label="Stop run" />
            </>
          }
        />
        <TaskRow
          title="Approve merge queue reorder"
          agent="Codex"
          state="waiting"
          detail="Waiting on human approval before the queue lands"
          elapsedLabel="0:38"
          onClick={() => {}}
          actions={<TaskRowActionButton icon={EyeIcon} label="Open task" />}
        />
        <TaskRow
          title="bun test apps/desktop failed"
          agent="Claude"
          state="failed"
          detail="3 assertions failed in the WebSocket reconnect suite"
          progress="3 failing"
          elapsedLabel="4:12"
          onClick={() => {}}
          actions={
            <>
              <TaskRowActionButton icon={RotateCcwIcon} label="Retry run" />
              <TaskRowActionButton icon={XIcon} label="Dismiss" />
            </>
          }
        />
        <TaskRow
          title="Verified vendor records"
          agent="Codex"
          state="done"
          detail="All acceptance criteria met — ready for review"
          progress="12/12"
          elapsedLabel="6:05"
          onClick={() => {}}
        />
        <TaskRow
          title="Draft supplier emails"
          agent="Claude"
          state="queued"
          detail="Queued behind 2 other tasks on this repo"
          progress="0/3"
        />
      </TaskRowList>
    ),
  },
  {
    id: 'chat-panel-two-tabs',
    title: 'Chat panel — two tabs, mixed messages',
    note: 'Segmented tab strip (active tab lifted, unread dot on "Boot force-fail"), right-aligned user bubbles vs. full-width agent replies, and a PromptBar placeholder pinned to the bottom. Click a tab to switch.',
    render: () => <ChatPanelDemo />,
  },
  {
    id: 'prompt-bar-empty',
    title: 'Prompt bar — empty',
    note: 'Inset field with a focus-within accent ring, model picker, dictation affordance, and a submit button disabled until there is text. Click in and type to try it.',
    render: () => <PromptBarEmptyDemo />,
  },
  {
    id: 'prompt-bar-filled-with-references',
    title: 'Prompt bar — filled, with reference chips',
    note: 'Two file chips and a branch chip above the textarea, each removable; submit is enabled since there is text. Click a chip’s × to remove it.',
    render: () => <PromptBarWithReferencesDemo />,
  },
  {
    id: 'prompt-bar-command-popover',
    title: 'Prompt bar — command popover open',
    note: 'Typing "/re" filters the command list to label-prefix matches (Retry, Review, Redirect) via matchCommands, case-insensitively.',
    render: () => <PromptBarCommandPopoverDemo />,
  },
  ...recommendationCardStories,
  ...contextCardsStories,
  ...diffTableStories,
  ...recordsTableStories,
  ...filterTableStories,
  ...sidebarNavStories,
  ...searchStories,
  ...insightCardsStories,
  ...codeBlockStories,
  ...fineTuneCardStories,
  ...selectionActionsStories,
];
