import type {
  DraftRecord,
  MergeQueueEntry,
  MergeQueueEntryState,
  PlannerQuestion,
  PlanRecord,
  RunMeta,
  RunQuestion,
  RunState,
} from '@dispatch/client';

import type { InboxTarget } from './inbox';

/** A notification ready to hand to `notify(title, body)` — see notifications.ts. `target`
 * is where the notification's inbox row (see inbox.ts) should navigate on click. */
export interface PendingNotification {
  title: string;
  body: string;
  target: InboxTarget;
}

const RUN_NOTIFY_STATES: ReadonlySet<RunState> = new Set([
  'finished',
  'failed',
]);

/**
 * Pure edge-detector for run state transitions: compares the previous run-id → state
 * snapshot against the latest run list and returns a notification for every run that
 * *just* landed on 'finished' or 'failed', plus the snapshot to keep for next time.
 *
 * A run with no entry in `previous` never notifies, no matter its state — that's what
 * keeps app launch (or a project switch, which starts this hook's tracking over) from
 * firing a wave of notifications for every run that was already terminal before this
 * window started watching. `next` is rebuilt from scratch each call (not merged onto
 * `previous`), so its size always tracks the current run count rather than growing
 * unbounded across a long-lived session.
 */
export function diffRunNotifications(
  previous: ReadonlyMap<string, RunState>,
  runs: readonly RunMeta[]
): { notifications: PendingNotification[]; next: Map<string, RunState> } {
  const next = new Map<string, RunState>();
  const notifications: PendingNotification[] = [];

  for (const run of runs) {
    next.set(run.id, run.state);
    const prevState = previous.get(run.id);
    if (
      prevState !== undefined &&
      prevState !== run.state &&
      RUN_NOTIFY_STATES.has(run.state)
    ) {
      notifications.push({
        title: run.state === 'finished' ? 'Run finished' : 'Run failed',
        body: run.taskTitle,
        target: { kind: 'run', runId: run.id },
      });
    }
  }

  return { notifications, next };
}

// 'blocked-environment' notifies alongside the two terminal states because it
// is the one queue state that needs the PERSON to do something (commit, stash,
// switch branch) before anything else can move. The bug this addresses was
// precisely that a blocked merge was silent — the entry used to fail straight
// into history and the queue looked like it had swallowed the run.
const QUEUE_NOTIFY_STATES: ReadonlySet<MergeQueueEntryState> = new Set([
  'merged',
  'failed',
  'blocked-environment',
]);

/**
 * Pure edge-detector for merge-queue entry transitions — same shape and same "first
 * sighting never notifies" rule as `diffRunNotifications` above, but for merge-queue
 * entries instead of runs. Callers must pass the *combined* active-entries + history
 * list (`[...snapshot.entries, ...snapshot.history]`): a terminal entry moves out of
 * `entries` and into `history` in the same update that flips its state, so watching
 * only `entries` would miss every merged/failed transition entirely.
 */
export function diffQueueNotifications(
  previous: ReadonlyMap<string, MergeQueueEntryState>,
  entries: readonly MergeQueueEntry[]
): {
  notifications: PendingNotification[];
  next: Map<string, MergeQueueEntryState>;
} {
  const next = new Map<string, MergeQueueEntryState>();
  const notifications: PendingNotification[] = [];

  for (const entry of entries) {
    // Re-enqueued runs appear in both entries and history; keep the first (current)
    // occurrence and skip duplicates to avoid older history entries overwriting live state.
    if (next.has(entry.runId)) continue;

    next.set(entry.runId, entry.state);
    const prevState = previous.get(entry.runId);
    if (
      prevState !== undefined &&
      prevState !== entry.state &&
      QUEUE_NOTIFY_STATES.has(entry.state)
    ) {
      if (entry.state === 'merged') {
        notifications.push({
          title: 'Merged',
          body: entry.taskTitle,
          target: { kind: 'queue' },
        });
      } else if (entry.state === 'blocked-environment') {
        notifications.push({
          title: 'Merge blocked — action needed',
          body: `${entry.taskTitle} — ${(entry.reason ?? '').slice(0, 80)}`,
          target: { kind: 'queue' },
        });
      } else {
        const reason = (entry.reason ?? '').slice(0, 80);
        notifications.push({
          title: 'Merge failed',
          body: `${entry.taskTitle} — ${reason}`,
          target: { kind: 'queue' },
        });
      }
    }
  }

  return { notifications, next };
}

/** Per-asker signature of the last-seen planner questions (planner ids repeat across
 * turns, so the text is in the key), plus every run-question id already seen. */
export interface QuestionTracking {
  askers: Map<string, string>;
  runQuestionIds: Set<string>;
}

export function emptyQuestionTracking(): QuestionTracking {
  return { askers: new Map(), runQuestionIds: new Set() };
}

// A stable key for one asker's current question set — id and text of each question, so a
// new round with recycled ids reads as different from the round before it.
function signatureOf(questions: readonly PlannerQuestion[]): string {
  return questions.map((q) => `${q.id}|${q.question}`).join('||');
}

/** Pure edge-detector for questions waiting on the user — planner questions on drafts and
 * the open plan, plus run agents' questions. First sighting never notifies. */
export function diffQuestionNotifications(
  previous: QuestionTracking,
  drafts: readonly DraftRecord[],
  planRecord: PlanRecord | undefined,
  openQuestions: ReadonlyMap<string, RunQuestion[]>
): { notifications: PendingNotification[]; next: QuestionTracking } {
  const next = emptyQuestionTracking();
  const notifications: PendingNotification[] = [];

  const askers: {
    key: string;
    questions: readonly PlannerQuestion[];
    title: string;
    body: string;
    target: InboxTarget;
  }[] = [
    ...drafts.map((d) => ({
      key: `draft:${d.id}`,
      questions: d.questions,
      title: 'The planner needs your answer',
      body: d.prompt,
      target: { kind: 'draft' as const, draftId: d.id },
    })),
    ...(planRecord === undefined
      ? []
      : [
          {
            key: `plan:${planRecord.id}`,
            questions: planRecord.questions,
            title: 'The planner needs your answer',
            body: planRecord.prompt,
            target: { kind: 'plan' as const, planId: planRecord.id },
          },
        ]),
  ];

  for (const asker of askers) {
    const signature = signatureOf(asker.questions);
    next.askers.set(asker.key, signature);
    const previousSignature = previous.askers.get(asker.key);
    if (
      previousSignature !== undefined &&
      previousSignature !== signature &&
      asker.questions.length > 0
    ) {
      notifications.push({
        title: asker.title,
        body: asker.body,
        target: asker.target,
      });
    }
  }

  for (const [runId, questions] of openQuestions) {
    for (const question of questions) {
      next.runQuestionIds.add(question.id);
      if (previous.runQuestionIds.has(question.id)) continue;
      // A run question id is unique and only appears once open, so its first
      // sighting is the edge; the project-switch reset is the guard.
      notifications.push({
        title: 'An agent needs your answer',
        body: question.question,
        target: { kind: 'run', runId },
      });
    }
  }

  return { notifications, next };
}
