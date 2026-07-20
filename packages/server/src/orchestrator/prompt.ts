import type { TaskDoc } from '@dispatch/core';

// Builds the exact prompt handed to an executor for a newly-dispatched task:
// everything a from-scratch agent needs to act on it without any other
// context — the task's own file content (title + full body, which already
// carries its Description/Acceptance Criteria/Activity sections per core's
// task template), its parent epic's title + body when it has one, a pointer
// at this repo's own contribution conventions, a collaboration note steering
// the agent toward the dispatch MCP tools other agents also use, and an
// explicit instruction to commit before finishing. Kept as a pure function
// of its two TaskDoc inputs (no executor, no I/O) so it's unit-testable with
// a fixture task and snapshot-stable independent of anything else the
// orchestrator does.
export function buildTaskPrompt(
  task: TaskDoc,
  parentEpic: TaskDoc | null
): string {
  const sections: string[] = [
    `# Task ${task.meta.id}: ${task.meta.title}`,
    task.body.trim(),
  ];

  if (parentEpic !== null) {
    sections.push(
      `## Parent epic: ${parentEpic.meta.id} — ${parentEpic.meta.title}\n\n${parentEpic.body.trim()}`
    );
  }

  sections.push(
    "Follow this repository's own contribution conventions (AGENTS.md / " +
      'CLAUDE.md at the repo root, and any .agents/skills or .claude/skills ' +
      'entries relevant to the change) exactly as a human contributor would.'
  );

  sections.push(
    'Other agents may be dispatched on other tasks in this tracker at the ' +
      'same time: check `run_list` via the dispatch MCP server before ' +
      'assuming you have exclusive access to the repo, and log meaningful ' +
      "progress with `task_comment` — this task's Activity log is the " +
      'shared record other agents and humans will read.'
  );

  sections.push(
    'Commit your work (git add / git commit) before finishing — an ' +
      'uncommitted worktree cannot be reviewed or merged.'
  );

  return sections.join('\n\n');
}
