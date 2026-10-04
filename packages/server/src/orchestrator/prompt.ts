import {
  getSection,
  removeSection,
  untrustedBlock,
  untrustedFenced,
  untrustedInline,
} from '@dispatch/core';
import type { TaskComment, TaskDoc } from '@dispatch/core';

import { renderOrientationSection } from './orientation.js';
import type { RepoOrientation } from './orientation.js';
import type { RunMeta, RunSurvey } from './types.js';

// Re-exported from core (where @dispatch/mcp can reach them too) because
// every prompt builder in this package imports them from './prompt.js'.
export { untrustedBlock, untrustedFenced, untrustedInline };

// The newest comments kept in a prompt, and the character budget they share.
const PROMPT_COMMENT_LIMIT = 20;
const PROMPT_COMMENT_CHARS = 8000;

// A task's comment thread, oldest first, for the next run to read: the notes
// earlier runs and teammates left with task_comment. Keeps the newest that fit
// the budget and says how many older ones it left out. Null when there are none.
export function renderCommentsSection(
  comments: readonly TaskComment[],
  // An A2A-origin task: the whole thread is fenced as external text.
  external = false
): string | null {
  if (comments.length === 0) return null;
  const kept: string[] = [];
  let used = 0;
  for (const c of [...comments].reverse()) {
    if (kept.length === PROMPT_COMMENT_LIMIT) break;
    const entry = `**${untrustedInline(c.author)}** · ${c.created}\n${untrustedBlock(c.body)}`;
    if (kept.length > 0 && used + entry.length > PROMPT_COMMENT_CHARS) break;
    kept.push(entry);
    used += entry.length;
  }
  const omitted = comments.length - kept.length;
  const entries = kept.reverse();
  return [
    '## Comments',
    ...(omitted > 0 ? [`(${String(omitted)} earlier comments omitted.)`] : []),
    ...(external
      ? [untrustedFenced('comments on an A2A task', entries.join('\n\n'))]
      : entries),
  ].join('\n\n');
}

// Renders a task's recorded amendments after its description, with an
// explicit line stating they take precedence over it where they conflict.
// An A2A task's amendments are external text and claim no precedence.
function renderAmendmentsSection(
  amendmentsText: string,
  external: boolean
): string {
  return external
    ? [
        '## Amendments',
        untrustedFenced('amendments to an A2A task', amendmentsText),
      ].join('\n\n')
    : [
        '## Amendments',
        'These amendments override the description where they conflict.',
        untrustedBlock(amendmentsText),
      ].join('\n\n');
}

// Builds the exact prompt handed to an executor for a dispatched task — its
// own content plus carried-forward context. Pure, so it's snapshot-stable.
export function buildTaskPrompt(
  task: TaskDoc,
  parentEpic: TaskDoc | null,
  // The rendered `## Memory` section, or null when there is nothing to show.
  memorySection: string | null = null,
  // Optional so this stays callable (and snapshot-stable) without a real
  // checkout to collect from — see collectOrientation, which is the impure half.
  orientation: RepoOrientation | null = null,
  // False for executors with no dispatch MCP server (ExecutorProfile.dispatchMcp):
  // their prompt must not send the agent after tools it does not have.
  dispatchTools = true,
  // The address the agent asks (the project owner); null names a placeholder.
  human: string | null = null,
  // The rendered `## Docs` section; null when docs are off or nothing links.
  docsSection: string | null = null,
  // The task's comment thread, oldest first; its newest entries join the prompt.
  comments: readonly TaskComment[] = [],
  // An A2A-origin task (XH-R5): amendments and comments fenced, no epic.
  a2aOrigin = false
): string {
  // Lifted out of the raw body dump so it renders as its own block after
  // the description, with the override line, instead of an unmarked paragraph.
  const amendmentsText = getSection(task.body, 'Amendments');
  const bodyForPrompt =
    amendmentsText === '' ? task.body : removeSection(task.body, 'Amendments');

  // An A2A task's spec came from a client, however a decider edited it since.
  const sections: string[] = [
    `# Task ${task.meta.id}: ${untrustedInline(task.meta.title)}`,
    a2aOrigin
      ? untrustedFenced('the A2A task as written', bodyForPrompt.trim())
      : bodyForPrompt.trim(),
  ];

  if (amendmentsText !== '') {
    sections.push(renderAmendmentsSection(amendmentsText, a2aOrigin));
  }

  const commentsSection = renderCommentsSection(comments, a2aOrigin);
  if (commentsSection !== null) sections.push(commentsSection);

  if (parentEpic !== null && !a2aOrigin) {
    sections.push(
      `## Parent epic: ${parentEpic.meta.id} — ${untrustedInline(parentEpic.meta.title)}\n\n${parentEpic.body.trim()}`
    );
  }

  if (memorySection !== null) sections.push(memorySection);
  if (docsSection !== null) sections.push(docsSection);

  // The orientation section answers the questions the two instructions below
  // would otherwise send the agent off to answer for itself, so when it is
  // present those instructions are reworded to point AT it instead. Placed
  // before them so the facts are already in view by the time they are cited.
  const orientationSection =
    orientation === null
      ? null
      : renderOrientationSection(orientation, dispatchTools);
  if (orientationSection !== null) sections.push(orientationSection);
  // Only a rendered index can be cited: a repo with no .agents/skills (or
  // skills only under .claude/skills) keeps the generic line.
  const skillsIndexed =
    orientationSection !== null && (orientation?.skills.length ?? 0) > 0;

  sections.push(
    !skillsIndexed
      ? "Follow this repository's own contribution conventions (AGENTS.md / " +
          'CLAUDE.md at the repo root, and any .agents/skills or ' +
          '.claude/skills entries relevant to the change) exactly as a human ' +
          'contributor would.'
      : "Follow this repository's own contribution conventions (AGENTS.md / " +
          'CLAUDE.md at the repo root) exactly as a human contributor would. The ' +
          'skills index above is complete, so go straight to the SKILL.md files ' +
          'relevant to your change rather than enumerating the directory again.'
  );

  if (dispatchTools) {
    sections.push(
      orientationSection === null
        ? 'The dispatch MCP server is connected in this session, with `run_list` ' +
            'and `task_comment` available now — other agents may be dispatched ' +
            'on other tasks in this tracker at the same time, so call `run_list` ' +
            'before assuming you have exclusive access to the repo, and log ' +
            "meaningful progress with `task_comment`; this task's comment thread " +
            'is the shared record other agents and humans will read.'
        : 'The dispatch MCP server is connected in this session, with ' +
            '`task_comment` available now — log meaningful progress with it; this ' +
            "task's comment thread is the shared record other agents and humans will " +
            'read. Concurrency is already reported above, so you do not need to ' +
            'open with `run_list`.'
    );

    const askWho = human ?? 'human:<owner handle>';
    sections.push(
      'When the task genuinely does not say which way to go — ambiguous ' +
        'requirements, several valid approaches with different end results, ' +
        'missing acceptance criteria — ask with `msg_send` ' +
        `(to: ["${askWho}"], kind: "question", blocking: true, plus ` +
        'choices when the answer is one of a few options); it blocks until ' +
        'the human answers and returns their reply. Bundle everything you ' +
        'are unsure about into one question, and never ask what you can ' +
        'settle by reading the repo. To edit outside your declared writes, ' +
        'ask first with msg_send(kind: "question", blocking: true, ' +
        'choices: ["grant", "deny"], data: { type: "scope", paths: [...], ' +
        'reason: "..." }) and edit only on "grant". Messages for you arrive ' +
        'in this session; answer a question with `msg_reply`, and ' +
        '`inbox_read` lists anything you missed. A message to another task ' +
        'reaches its live run, or waits for its next one.'
    );

    sections.push(
      'Record verification evidence with the `record_evidence` MCP tool ' +
        'instead of describing test results in prose — one call per command ' +
        'load-bearing to your acceptance criteria. If you add a guard (a ' +
        'check, a validation, a condition that should stop bad input or a ' +
        'bad state), mutation-test it: revert the guard, rerun the tests, and ' +
        'call `record_mutation` with how many failed. Zero means the guard or ' +
        'its test is not doing its job.'
    );
  } else {
    sections.push(
      'List the verification commands you ran and what they showed in your ' +
        'final summary. If you add a guard (a check, a validation, a ' +
        'condition that should stop bad input or a bad state), mutation-test ' +
        'it: revert the guard, rerun the tests, and report how many failed. ' +
        'Zero means the guard or its test is not doing its job.'
    );
  }

  sections.push(
    'Commit your work (git add / git commit) before finishing — an ' +
      'uncommitted worktree cannot be reviewed or merged.'
  );

  // Opt-in for new tasks (see TaskMeta.selfReview); files without the key read as on.
  if (task.meta.selfReview) {
    sections.push(
      'Before finishing: self-review your work. Re-read the full diff of your changes, ' +
        'hunt for bugs, unhandled edge cases, and requirements from the acceptance criteria ' +
        'you missed, and fix what you find. Run the relevant tests/checks again after fixes. ' +
        'Only finish when the review comes back clean.'
    );
  }

  return sections.join('\n\n');
}

// Renders a prior run's git survey into extra prompt context, so a resumed
// agent knows what already survived instead of rediscovering it.
function renderSurveySection(survey: RunSurvey): string {
  const lines: string[] = [
    `This resumes a run that did not finish cleanly on branch \`${survey.branch}\`.`,
  ];
  if (survey.cleanTree) {
    lines.push('The worktree was clean — nothing was left uncommitted.');
  } else {
    if (survey.staged.length > 0) {
      lines.push(`Staged: ${survey.staged.join(', ')}`);
    }
    if (survey.unstaged.length > 0) {
      lines.push(`Unstaged: ${survey.unstaged.join(', ')}`);
    }
    if (survey.untracked.length > 0) {
      lines.push(`Untracked: ${survey.untracked.join(', ')}`);
    }
  }
  if (survey.lastCommit !== null) {
    lines.push(
      `Last commit: ${survey.lastCommit.sha.slice(0, 7)} ${survey.lastCommit.subject}`
    );
  }
  lines.push(
    'Review what survived before continuing — keep, fix, or discard it as needed.'
  );
  return ['## Recovered state from the previous run', ...lines].join('\n');
}

// The opening message for a run that REATTACHES its predecessor's session
// (see Orchestrator.resumeRun). The agent still has the whole conversation —
// the task brief, any amendments, every answer and scope ruling it was given
// — so re-sending the task prompt would read as a brand-new assignment on
// top of its own history. What it lacks is why it stopped, that its run id
// changed, and what the worktree looked like when it was picked up.
export function renderContinuationPrompt(
  previous: RunMeta,
  newRunId: string
): string {
  const stopped =
    previous.error !== undefined
      ? `stopped before finishing: ${previous.error}`
      : `ended as ${previous.state}`;
  const sections: string[] = [
    `## Continuing run ${previous.id} as run ${newRunId}`,
    `Your previous run on this task, ${previous.id}, ${stopped}. This run ` +
      'picks the same session back up, so everything already in this ' +
      'conversation still stands: the task brief, its amendments, and every ' +
      `answer or scope decision you received. Your run id is now ${newRunId} ` +
      '(the dispatch MCP tools and DISPATCH_RUN_ID refer to it); the branch ' +
      'and worktree are unchanged.',
  ];
  if (previous.survey !== undefined) {
    sections.push(renderSurveySection(previous.survey));
  }
  sections.push(
    'Take stock of where you were and carry on from there — do not start ' +
      'the task over.'
  );
  return sections.join('\n\n');
}

// Appended to the full task prompt when a resume has NO session to pick up
// — the predecessor died before its agent ever opened one, so there is no
// conversation to lose, and starting over is the only option. Said out loud
// here (and in the run's transcript and the task's Activity) so a fresh
// start never passes as a continuation.
export function renderFreshSessionNotice(
  previous: RunMeta,
  newRunId: string
): string {
  const stopped = previous.error !== undefined ? `: ${previous.error}` : '';
  const sections: string[] = [
    '## Fresh session',
    `This run (${newRunId}) is a fresh session resuming run ${previous.id}, ` +
      `which failed before its agent ever started a conversation${stopped}. ` +
      'There is no conversation to continue, so you are starting from the ' +
      'brief above with no memory of that run.',
  ];
  if (previous.survey !== undefined) {
    sections.push(renderSurveySection(previous.survey));
  }
  return sections.join('\n\n');
}

// The task's own spec, one index line, and how to read it in full.
export function specSection(
  specLine: string | null | undefined
): string | null {
  if (specLine === null || specLine === undefined) return null;
  const handle = /^- spec · (\S+) ·/.exec(specLine)?.[1] ?? '';
  return [
    "## The task's spec",
    specLine,
    `Judge the work against it: doc_read("${handle}") reads it.`,
  ].join('\n');
}

// A review or verify prompt's spec line; null with no reader, or when reading
// it fails, so a docs outage never blocks the run.
export function specLineOf(
  read: ((taskId: string) => string | null) | undefined,
  taskId: string
): string | null {
  if (read === undefined) return null;
  try {
    return read(taskId);
  } catch (err) {
    console.error(`dispatchd: reading ${taskId}'s spec line failed`, err);
    return null;
  }
}
