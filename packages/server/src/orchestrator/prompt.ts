import {
  getSection,
  removeSection,
  untrustedBlock,
  untrustedFenced,
  untrustedInline,
} from '@dispatch/core';
import type { LedgerEntry, TaskDoc } from '@dispatch/core';

import type { RunSurvey } from './types.js';

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
  ledgerEntries: LedgerEntry[] = []
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

  sections.push(
    "Follow this repository's own contribution conventions (AGENTS.md / " +
      'CLAUDE.md at the repo root, and any .agents/skills or .claude/skills ' +
      'entries relevant to the change) exactly as a human contributor would.'
  );

  sections.push(
    'The dispatch MCP server is connected in this session, with `run_list` ' +
      'and `task_comment` available now — other agents may be dispatched ' +
      'on other tasks in this tracker at the same time, so call `run_list` ' +
      'before assuming you have exclusive access to the repo, and log ' +
      "meaningful progress with `task_comment`; this task's Activity log " +
      'is the shared record other agents and humans will read.'
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
