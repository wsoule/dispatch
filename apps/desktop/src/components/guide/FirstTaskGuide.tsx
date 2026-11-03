import type { DraftRecord } from '@dispatch/client';
import {
  Button,
  ConfirmDialog,
  cx,
  Panel,
  Spinner,
  TextArea,
} from '@dispatch/ui';
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
import {
  GUIDE_STEPS,
  type GuideProvider,
  type GuideView,
} from '../../lib/firstTaskGuide';
import { formatUsd } from '../../lib/milestoneSession';
import { FailureNotice } from '../failure/FailureNotice';
import { useNarrowMain } from '../shell/DispatchShell';
import { GlossaryTerm } from './GlossaryTerm';
import styles from './guide.module.css';
import {
  type SendChoice,
  SendToAgent,
  type SendToAgentOptions,
} from './SendToAgent';

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

// A stage's sentence, in the card's secondary text.
function Line({ children }: { children: ReactNode }) {
  return <p className={styles.line}>{children}</p>;
}

// A quieter note beside a Spinner, or what the run draws on. Beside a
// Spinner (which is hidden from assistive tech) it is a polite status, so
// the drafting and working words are announced as they change.
function Quiet({
  children,
  status = false,
}: {
  children: ReactNode;
  status?: boolean;
}) {
  return (
    <p className={styles.quiet} role={status ? 'status' : undefined}>
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
          <Quiet status>
            <Spinner size="xs" label="" />
            Drafting your task…
          </Quiet>
        ) : (
          <Line>The planner has a question before it can draft your task.</Line>
        )}
        <Button
          size="sm"
          variant="secondary"
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
      <div className={styles.buttons}>
        <Button size="sm" variant="secondary" onClick={actions.showDescribe}>
          Show me where
        </Button>
        <Button size="sm" variant="quiet" onClick={actions.dismiss}>
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
            variant="quiet"
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
            variant="secondary"
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
      <Quiet status>
        <Spinner size="xs" label="" />
        {step ?? run.lastStep?.text ?? 'Getting started…'}
      </Quiet>
      {cost !== null && <Quiet>{cost}</Quiet>}
      <Button
        size="sm"
        variant="secondary"
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
        variant="secondary"
        onClick={() => actions.openTask(taskId, 'review', runId)}
      >
        Show the changes
      </Button>
      {asking ? (
        <>
          <TextArea
            className={styles.textarea}
            rows={3}
            aria-label="What should change"
            placeholder="What should the agent change?"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className={cx(styles.buttons, styles.buttonsEnd)}>
            <Button
              size="sm"
              variant="quiet"
              disabled={busy}
              onClick={() => setAsking(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={busy || text.trim() === ''}
              onClick={() => void sendChanges()}
            >
              Send to the agent
            </Button>
          </div>
        </>
      ) : (
        <div className={styles.buttons}>
          <Button
            size="sm"
            variant="primary"
            onClick={() => actions.looksGood(runId)}
          >
            Looks good
          </Button>
          <Button size="sm" variant="quiet" onClick={() => setAsking(true)}>
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
        <div className={styles.buttons}>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => actions.openTask(taskId, 'review', runId)}
          >
            Open the review page
          </Button>
          <Button
            size="sm"
            variant="quiet"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            Start over
          </Button>
        </div>
        {error !== null && <FailureNotice error={error} />}
        {/* Sets the run aside, nothing more: the pull request stays on
            GitHub, so the confirm is the primary button, not danger. */}
        <ConfirmDialog
          open={confirming}
          title="Start this task over?"
          confirmLabel="Start the task over"
          cancelLabel="Cancel"
          tone="default"
          onConfirm={() => {
            setConfirming(false);
            void act(() => actions.startOver(runId));
          }}
          onCancel={() => setConfirming(false)}
        >
          The task goes back to Check the plan so you can change it and send it
          again. This won't close the pull request on GitHub: if it's still
          open, close it there.
        </ConfirmDialog>
      </>
    );
  }
  return (
    <>
      <Line>
        <GlossaryTerm term="land">Land</GlossaryTerm> it: add the agent's
        changes to your project.
      </Line>
      <Button
        size="sm"
        variant="primary"
        disabled={busy}
        icon={busy ? <Spinner size="xs" label="" /> : undefined}
        onClick={() => void land()}
      >
        Add these changes to your project
      </Button>
      {/* The button hides its Spinner from assistive tech and keeps its
          words, so this always-mounted line says the landing out loud. */}
      <span role="status" className="srOnly">
        {busy ? 'Adding the changes to your project…' : ''}
      </span>
      {failure !== null && <FailureNotice error={failure} onRetry={land} />}
    </>
  );
}

function DoneBody({ actions }: BodyProps) {
  return (
    <>
      <Line>Done. Your first change is in your project.</Line>
      <div className={styles.buttons}>
        <Button size="sm" variant="secondary" onClick={actions.openBoard}>
          See the board
        </Button>
        <Button size="sm" variant="secondary" onClick={actions.openOverseer}>
          Talk to the Overseer
        </Button>
        <Button size="sm" variant="secondary" onClick={actions.inviteTeammate}>
          Invite a teammate
        </Button>
      </div>
    </>
  );
}

type StepState = 'passed' | 'current' | 'next';

// Where step `i` sits against the current step's index.
function stepState(i: number, current: number): StepState {
  if (i < current) return 'passed';
  return i === current ? 'current' : 'next';
}

/* A step's mark: a check in success for a passed step, a dot in info for
   the current one, a quiet ring for one still to come. The li's
   aria-current and its words carry the meaning, so the mark is hidden and
   colour is never the only signal. */
function StepMark({ state }: { state: StepState }) {
  const icon = { size: 14, strokeWidth: 1.8, 'aria-hidden': true } as const;
  switch (state) {
    case 'passed':
      return (
        <span className={styles.mark} data-tone="success">
          <CircleCheck {...icon} />
        </span>
      );
    case 'current':
      return (
        <span className={styles.mark} data-tone="info">
          <CircleDot {...icon} />
        </span>
      );
    case 'next':
      return (
        <span className={styles.mark}>
          <Circle {...icon} />
        </span>
      );
  }
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
    <section
      aria-label="First-task guide"
      data-testid="first-task-guide"
      data-stage={view.stage}
      className={styles.guide}
    >
      <Panel
        as="div"
        floating
        heading={collapsed ? `Your first task · ${where}` : 'Your first task'}
        actions={
          <>
            <Button
              variant="quiet"
              size="sm"
              aria-label={collapsed ? 'Expand the guide' : 'Collapse the guide'}
              aria-expanded={!collapsed}
              icon={
                collapsed ? (
                  <ChevronUp size={14} strokeWidth={1.8} aria-hidden />
                ) : (
                  <ChevronDown size={14} strokeWidth={1.8} aria-hidden />
                )
              }
              onClick={() => onCollapsedChange(!collapsed)}
            />
            <Button
              variant="quiet"
              size="sm"
              aria-label="Close the guide"
              icon={<X size={14} strokeWidth={1.8} aria-hidden />}
              onClick={close}
            />
          </>
        }
      >
        {!collapsed && (
          <>
            <ol aria-label="Steps" className={styles.steps}>
              {GUIDE_STEPS.map((step, i) => (
                <li
                  key={step.stage}
                  aria-current={i === index ? 'step' : undefined}
                  className={styles.step}
                >
                  <StepMark state={stepState(i, index)} />
                  {step.label}
                </li>
              ))}
            </ol>
            <div className={styles.body}>
              {view.stage === 'describe' && <DescribeBody {...body} />}
              {view.stage === 'check' && <CheckBody {...body} />}
              {view.stage === 'works' && <WorksBody {...body} />}
              {view.stage === 'review' && <ReviewBody {...body} />}
              {view.stage === 'land' && <LandBody {...body} />}
              {done && <DoneBody {...body} />}
            </div>
          </>
        )}
      </Panel>
      {/* Ends the guide for this project, not the task: the primary button,
          not danger. */}
      <ConfirmDialog
        open={confirmClose}
        title="Close the guide?"
        confirmLabel="Close the guide for good"
        cancelLabel="Keep the guide"
        tone="default"
        onConfirm={() => {
          setConfirmClose(false);
          actions.dismiss();
        }}
        onCancel={() => setConfirmClose(false)}
      >
        Your task keeps going without it. You can start the guide again from
        Help in the project menu.
      </ConfirmDialog>
    </section>
  );
}
