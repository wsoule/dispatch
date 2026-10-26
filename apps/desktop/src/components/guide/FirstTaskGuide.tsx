import type { DraftRecord } from '@dispatch/client';
import {
  ChevronDown,
  ChevronUp,
  Circle,
  CircleCheck,
  CircleDot,
  X,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { useRunStep } from '../../hooks/useRunStep';
import { formatUsd } from '../../lib/epicSession';
import {
  GUIDE_STEPS,
  type GuideProvider,
  type GuideView,
} from '../../lib/firstTaskGuide';
import { FailureNotice } from '../failure/FailureNotice';
import { useNarrowMain } from '../shell/DispatchShell';
import { GlossaryTerm } from './GlossaryTerm';
import {
  type SendChoice,
  SendToAgent,
  type SendToAgentOptions,
} from './SendToAgent';
import { cn } from '@/lib/utils';
import { IconButton } from '@/ui/ai/icon-button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/alert-dialog';
import { Button } from '@/ui/button';
import { Panel, PanelHeader } from '@/ui/chrome';
import { Spinner } from '@/ui/spinner';
import { Textarea } from '@/ui/textarea';

export interface GuideActions {
  /** Brings the describe box back into view (Overseer, not set aside). */
  showDescribe: () => void;
  openDraft: (draftId: string) => void;
  openTask: (
    taskId: string,
    tab: 'spec' | 'run' | 'review',
    runId?: string
  ) => void;
  send: (taskId: string, choice: SendChoice) => Promise<void>;
  retryDraft: (draft: DraftRecord) => Promise<void>;
  retryRun: (taskId: string) => Promise<void>;
  askAgentToFix: (runId: string, error: string) => Promise<void>;
  looksGood: (runId: string) => void;
  askForChanges: (runId: string, text: string) => Promise<void>;
  land: (runId: string) => Promise<void>;
  /** Sets a pull request run aside so the task goes back to Check the plan (e.g. closed unmerged). */
  startOver: (runId: string) => Promise<void>;
  dismiss: () => void;
  closeCompletion: () => void;
  openBoard: () => void;
  openOverseer: () => void;
  inviteTeammate: () => void;
}

interface FirstTaskGuideProps {
  view: GuideView;
  provider: GuideProvider | null;
  sendOptions: SendToAgentOptions;
  sendError: string | null;
  /** The person's explicit choice; null follows the window (collapsed when narrow). */
  collapsed: boolean | null;
  onCollapsedChange: (collapsed: boolean) => void;
  actions: GuideActions;
}

type BodyProps = Omit<FirstTaskGuideProps, 'collapsed' | 'onCollapsedChange'>;

function Line({ children }: { children: ReactNode }) {
  return (
    <p className="font-book text-[13px] leading-5 text-(--text-secondary)">
      {children}
    </p>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return (
    <p className="text-muted-foreground font-book flex items-center gap-1.5 text-[12px]">
      {children}
    </p>
  );
}

function DescribeBody({ view, provider, actions }: BodyProps) {
  const { draft, failure, waiting } = view;
  if (failure !== undefined && draft !== undefined) {
    return (
      <FailureNotice
        error={failure.error}
        providerId={failure.providerId}
        onRetry={() => actions.retryDraft(draft)}
      />
    );
  }
  if (waiting !== undefined && draft !== undefined) {
    return (
      <>
        {waiting === 'drafting' ? (
          <Quiet>
            <Spinner className="size-3" />
            Drafting your task…
          </Quiet>
        ) : (
          <Line>The planner has a question before it can draft your task.</Line>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => actions.openDraft(draft.id)}
        >
          Open the draft
        </Button>
      </>
    );
  }
  const plans = provider === null || provider.plans;
  return (
    <>
      <Line>
        {plans
          ? 'Describe the change you want in one sentence. You check the '
          : "Write what should change and how you'll know it's done. You check the "}
        <GlossaryTerm term="task">task</GlossaryTerm> before anything runs.
      </Line>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="outline" onClick={actions.showDescribe}>
          Show me where
        </Button>
        <Button size="sm" variant="link" onClick={actions.dismiss}>
          Skip — I know my way around
        </Button>
      </div>
    </>
  );
}

function CheckBody({ view, actions, sendOptions, sendError }: BodyProps) {
  const { draft, taskId } = view;
  return (
    <>
      <Line>
        This is what the <GlossaryTerm term="agent">agent</GlossaryTerm> will
        do. Edit anything, then send it.
      </Line>
      {taskId !== undefined ? (
        <>
          <SendToAgent
            options={sendOptions}
            onSend={(choice) => actions.send(taskId, choice)}
          />
          {sendError !== null && <FailureNotice error={sendError} />}
          <Button
            size="sm"
            variant="link"
            onClick={() => actions.openTask(taskId, 'spec')}
          >
            Open the task
          </Button>
        </>
      ) : draft !== undefined ? (
        <>
          <Quiet>Send to agent is at the bottom of the draft.</Quiet>
          <Button
            size="sm"
            variant="outline"
            onClick={() => actions.openDraft(draft.id)}
          >
            Open the draft
          </Button>
        </>
      ) : null}
    </>
  );
}

// What the run is paid from: the plan's own line, or the running cost on an API key.
function drawsOn(
  provider: GuideProvider | null,
  costUsd: number | undefined
): string | null {
  if (provider === null) return null;
  if (!provider.usingApiKey)
    return provider.blurb === '' ? null : provider.blurb;
  return costUsd === undefined
    ? 'Billed to your API key as it works.'
    : `Billed to your API key: ${formatUsd(costUsd)} so far.`;
}

function WorksBody({ view, provider, actions }: BodyProps) {
  const { run, taskId, failure } = view;
  const step = useRunStep(run?.id ?? null);
  if (run === undefined || taskId === undefined) return null;
  if (failure !== undefined) {
    return (
      <FailureNotice
        error={failure.error}
        providerId={failure.providerId}
        onRetry={() => actions.retryRun(taskId)}
        onAskAgent={
          run.sessionId === undefined
            ? undefined
            : () => actions.askAgentToFix(run.id, failure.error)
        }
      />
    );
  }
  const cost = drawsOn(provider, run.costUsd);
  return (
    <>
      <Line>
        The agent works on its own copy of your project. Nothing changes in your
        files until you say so.
      </Line>
      <Quiet>
        <Spinner className="size-3" />
        {step ?? run.lastStep?.text ?? 'Getting started…'}
      </Quiet>
      {cost !== null && <Quiet>{cost}</Quiet>}
      <Button
        size="sm"
        variant="outline"
        onClick={() => actions.openTask(taskId, 'run', run.id)}
      >
        Watch it work
      </Button>
    </>
  );
}

// Runs a guide action with a busy flag, keeping its error as a sentence to show.
function useGuideAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

function ReviewBody({ view, actions }: BodyProps) {
  const { run, taskId } = view;
  const [asking, setAsking] = useState(false);
  const [text, setText] = useState('');
  const { busy, error, run: act } = useGuideAction();
  if (run === undefined || taskId === undefined) return null;
  const runId = run.id;

  const sendChanges = () =>
    act(async () => {
      await actions.askForChanges(runId, text.trim());
      setText('');
      setAsking(false);
    });

  return (
    <>
      <Line>
        Green lines were added and red lines were removed. Check it does what
        you asked, then <GlossaryTerm term="review">review</GlossaryTerm> it
        here.
      </Line>
      <Button
        size="sm"
        variant="outline"
        onClick={() => actions.openTask(taskId, 'review', runId)}
      >
        Show the changes
      </Button>
      {asking ? (
        <>
          <Textarea
            rows={3}
            aria-label="What should change"
            placeholder="What should the agent change?"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex gap-1.5 self-end">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setAsking(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={busy || text.trim() === ''}
              onClick={() => void sendChanges()}
            >
              Send to the agent
            </Button>
          </div>
        </>
      ) : (
        <div className="flex gap-1.5">
          <Button size="sm" onClick={() => actions.looksGood(runId)}>
            Looks good
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAsking(true)}>
            Ask for changes
          </Button>
        </div>
      )}
      {error !== null && <FailureNotice error={error} />}
    </>
  );
}

function LandBody({ view, actions }: BodyProps) {
  const { run, taskId, waitingOnPr } = view;
  const { busy, error, run: act } = useGuideAction();
  const [confirming, setConfirming] = useState(false);
  if (run === undefined || taskId === undefined) return null;
  const runId = run.id;
  const land = () => act(() => actions.land(runId));
  // Only a refused merge belongs here; a failed discard is another story.
  const failure =
    error ??
    (run.reviewFailure?.action === 'merge' ? run.reviewFailure.reason : null);
  if (waitingOnPr === true) {
    return (
      <>
        <Line>
          Your pull request is open. This step finishes when it merges. If it
          was closed without merging, start over and send the task again.
        </Line>
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={() => actions.openTask(taskId, 'review', runId)}
          >
            Open the review page
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            Start over
          </Button>
        </div>
        {error !== null && <FailureNotice error={error} />}
        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Start this task over?</AlertDialogTitle>
              <AlertDialogDescription>
                The task goes back to Check the plan so you can change it and
                send it again. This won&apos;t close the pull request on GitHub:
                if it&apos;s still open, close it there.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel variant="ghost">Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setConfirming(false);
                  void act(() => actions.startOver(runId));
                }}
              >
                Start the task over
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  }
  return (
    <>
      <Line>
        <GlossaryTerm term="land">Land</GlossaryTerm> it: add the agent's
        changes to your project.
      </Line>
      <Button size="sm" disabled={busy} onClick={() => void land()}>
        {busy && <Spinner className="size-3.5" />}
        Add these changes to your project
      </Button>
      {failure !== null && <FailureNotice error={failure} onRetry={land} />}
    </>
  );
}

function DoneBody({ actions }: BodyProps) {
  return (
    <>
      <Line>Done. Your first change is in your project.</Line>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" onClick={actions.openBoard}>
          See the board
        </Button>
        <Button size="sm" variant="outline" onClick={actions.openOverseer}>
          Talk to the Overseer
        </Button>
        <Button size="sm" variant="outline" onClick={actions.inviteTeammate}>
          Invite a teammate
        </Button>
      </div>
    </>
  );
}

/**
 * The first-task guide: a small card over either view that follows one task from a
 * sentence to landed, five steps, while the person uses the real screens.
 */
export function FirstTaskGuide({
  collapsed: chosen,
  onCollapsedChange,
  ...body
}: FirstTaskGuideProps) {
  const { view, actions } = body;
  const narrow = useNarrowMain();
  const collapsed = chosen ?? narrow;
  const done = view.stage === 'done';
  // Past Describe, closing ends the guide for this project, so it asks first.
  const [confirmClose, setConfirmClose] = useState(false);
  const close = () => {
    if (done) actions.closeCompletion();
    else if (view.stage === 'describe') actions.dismiss();
    else setConfirmClose(true);
  };
  const index = done
    ? GUIDE_STEPS.length
    : GUIDE_STEPS.findIndex((s) => s.stage === view.stage);
  const where = done
    ? 'Done'
    : `Step ${index + 1} of ${GUIDE_STEPS.length}: ${GUIDE_STEPS[index]?.label ?? ''}`;
  return (
    <Panel className="bg-background shadow-overlay w-80 max-w-full">
      <section
        aria-label="First-task guide"
        data-testid="first-task-guide"
        data-stage={view.stage}
      >
        <PanelHeader
          actions={
            <>
              <IconButton
                label={collapsed ? 'Expand the guide' : 'Collapse the guide'}
                aria-expanded={!collapsed}
                onClick={() => onCollapsedChange(!collapsed)}
              >
                {collapsed ? <ChevronUp /> : <ChevronDown />}
              </IconButton>
              <IconButton label="Close the guide" onClick={close}>
                <X />
              </IconButton>
            </>
          }
        >
          {collapsed ? `Your first task · ${where}` : 'Your first task'}
        </PanelHeader>
        {!collapsed && (
          <>
            <ol aria-label="Steps" className="flex flex-col gap-1 px-3 pt-2">
              {GUIDE_STEPS.map((step, i) => (
                <li
                  key={step.stage}
                  aria-current={i === index ? 'step' : undefined}
                  className={cn(
                    'flex items-center gap-2 text-[12px]',
                    i === index
                      ? 'text-foreground font-medium'
                      : 'text-muted-foreground'
                  )}
                >
                  {i < index ? (
                    <CircleCheck
                      aria-hidden
                      className="text-state-review size-3.5"
                    />
                  ) : i === index ? (
                    <CircleDot
                      aria-hidden
                      className="text-state-working size-3.5"
                    />
                  ) : (
                    <Circle aria-hidden className="size-3.5" />
                  )}
                  {step.label}
                </li>
              ))}
            </ol>
            <div className="flex flex-col items-start gap-2 px-3 pt-2 pb-3">
              {view.stage === 'describe' && <DescribeBody {...body} />}
              {view.stage === 'check' && <CheckBody {...body} />}
              {view.stage === 'works' && <WorksBody {...body} />}
              {view.stage === 'review' && <ReviewBody {...body} />}
              {view.stage === 'land' && <LandBody {...body} />}
              {done && <DoneBody {...body} />}
            </div>
          </>
        )}
      </section>
      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close the guide?</AlertDialogTitle>
            <AlertDialogDescription>
              Your task keeps going without it. You can start the guide again
              from Help in the project menu.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel variant="ghost">
              Keep the guide
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmClose(false);
                actions.dismiss();
              }}
            >
              Close the guide for good
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  );
}
