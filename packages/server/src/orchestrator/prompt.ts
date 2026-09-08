import {
  getSection,
  removeSection,
  untrustedBlock,
  untrustedFenced,
  untrustedInline,
} from '@dispatch/core';
import type { LedgerEntry, TaskDoc } from '@dispatch/core';

import { renderOrientationSection } from './orientation.js';
import type { RepoOrientation } from './orientation.js';
import type { RunMeta, RunSurvey } from './types.js';

// Re-exported from core (where @dispatch/mcp can reach them too) because
// every prompt builder in this package imports them from './prompt.js'.
export { untrustedBlock, untrustedFenced, untrustedInline };

// Terse bulleted section for entries carried forward, or null (no header
// at all) when there are none — this goes into every dispatch prompt.
function renderLedgerSection(entries: LedgerEntry[]): string | null {
  if (entries.length === 0) return null;
  const lines = entries.map(
    (e) =>
      `- **${e.kind}**: ${untrustedInline(e.title)} — ${untrustedInline(e.detail)}`
  );
  return ['## Findings and decisions from earlier work', ...lines].join('\n');
}

// Renders a task's recorded amendments after its description, with an
// explicit line stating they take precedence over it where they conflict.
function renderAmendmentsSection(amendmentsText: string): string {
  return [
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
  ledgerEntries: LedgerEntry[] = [],
  // Optional so this stays callable (and snapshot-stable) without a real
  // checkout to collect from — see collectOrientation, which is the impure half.
  orientation: RepoOrientation | null = null
): string {
  // Lifted out of the raw body dump so it renders as its own block after
  // the description, with the override line, instead of an unmarked paragraph.
  const amendmentsText = getSection(task.body, 'Amendments');
  const bodyForPrompt =
    amendmentsText === '' ? task.body : removeSection(task.body, 'Amendments');

  const sections: string[] = [
    `# Task ${task.meta.id}: ${untrustedInline(task.meta.title)}`,
    bodyForPrompt.trim(),
  ];

  if (amendmentsText !== '') {
    sections.push(renderAmendmentsSection(amendmentsText));
  }

  if (parentEpic !== null) {
    sections.push(
      `## Parent epic: ${parentEpic.meta.id} — ${untrustedInline(parentEpic.meta.title)}\n\n${parentEpic.body.trim()}`
    );
  }

  const ledgerSection = renderLedgerSection(ledgerEntries);
  if (ledgerSection !== null) sections.push(ledgerSection);

  // The orientation section answers the questions the two instructions below
  // would otherwise send the agent off to answer for itself, so when it is
  // present those instructions are reworded to point AT it instead. Placed
  // before them so the facts are already in view by the time they are cited.
  const orientationSection =
    orientation === null ? null : renderOrientationSection(orientation);
  if (orientationSection !== null) sections.push(orientationSection);

  sections.push(
    orientationSection === null
      ? "Follow this repository's own contribution conventions (AGENTS.md / " +
          'CLAUDE.md at the repo root, and any .agents/skills or ' +
          '.claude/skills entries relevant to the change) exactly as a human ' +
          'contributor would.'
      : "Follow this repository's own contribution conventions (AGENTS.md / " +
          'CLAUDE.md at the repo root) exactly as a human contributor would. The ' +
          'skills index above is complete, so go straight to the SKILL.md files ' +
          'relevant to your change rather than enumerating the directory again.'
  );

  sections.push(
    orientationSection === null
      ? 'The dispatch MCP server is connected in this session, with `run_list` ' +
          'and `task_comment` available now — other agents may be dispatched ' +
          'on other tasks in this tracker at the same time, so call `run_list` ' +
          'before assuming you have exclusive access to the repo, and log ' +
          "meaningful progress with `task_comment`; this task's Activity log " +
          'is the shared record other agents and humans will read.'
      : 'The dispatch MCP server is connected in this session, with ' +
          '`task_comment` available now — log meaningful progress with it; this ' +
          "task's Activity log is the shared record other agents and humans will " +
          'read. Concurrency is already reported above, so you do not need to ' +
          'open with `run_list`.'
  );

  sections.push(
    'When the task genuinely does not say which way to go — ambiguous ' +
      'requirements, several valid approaches with different end results, ' +
      'missing acceptance criteria — call `ask_user`; it blocks until the ' +
      'human answers and returns their reply. Use it whenever a decision ' +
      'would change the shape of the result and the task does not specify ' +
      'it, and bundle everything you are unsure about into one call rather ' +
      'than asking repeatedly. Do not use it for anything you can settle by ' +
      'reading the repo (existing conventions, how a helper behaves, where ' +
      'a file lives) — find that out yourself.'
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

  sections.push(
    'Commit your work (git add / git commit) before finishing — an ' +
      'uncommitted worktree cannot be reviewed or merged.'
  );

  // On by default, opted out per-task with `self-review: false` in frontmatter.
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
export function renderSurveySection(survey: RunSurvey): string {
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

// The slice of a scope request a resumed agent is told about — see
// renderScopeRequestsSection. Named here rather than importing the registry's
// record so the prompt module stays free of orchestrator state.
export interface CarriedScopeRequest {
  id: string;
  paths: string[];
  reason: string;
  granted: boolean | null;
  decisionReason: string | null;
  decidedBy: string | null;
}

// Tells a resumed agent what became of the out-of-fence requests its previous
// process was parked on when dispatchd restarted: still open ones are waiting
// on a human and re-issuing `request_scope` with the same paths re-parks on
// them; decided ones carry the ruling, since the poll that would have
// delivered it died with the process. Null when nothing was carried.
export function renderScopeRequestsSection(
  requests: CarriedScopeRequest[]
): string | null {
  if (requests.length === 0) return null;
  const lines = requests.map((r) => {
    const paths = r.paths.map((p) => `\`${p}\``).join(', ');
    const why = untrustedInline(r.reason);
    if (r.granted === null) {
      return (
        `- ${r.id} (${paths}) — ${why}. **Still awaiting a decision.** If you ` +
        'still need these paths, call `request_scope` again with exactly the ' +
        'same paths: it re-attaches to this pending request rather than filing ' +
        'a new one, and blocks until a human decides. Until then, stay inside ' +
        'your declared writes.'
      );
    }
    const verdict = r.granted ? 'GRANTED' : 'DENIED';
    const by = r.decidedBy === null ? '' : ` via ${r.decidedBy}`;
    const ruling =
      r.decisionReason === null ? '' : `: ${untrustedInline(r.decisionReason)}`;
    return `- ${r.id} (${paths}) — ${why}. **${verdict}${by}**${ruling}`;
  });
  return [
    '## Scope requests from before the restart',
    'Your previous process asked to edit outside its declared scope and was ' +
      'interrupted by a dispatchd restart before the answer reached it.',
    ...lines,
  ].join('\n');
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
