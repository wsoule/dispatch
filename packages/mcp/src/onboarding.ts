// Markdown served at the `workflow://onboarding` MCP resource. Written for an
// agent audience: a short, self-contained brief on how to use the `task_*`
// tools productively, without having to read the rest of the codebase first.
export const ONBOARDING_MARKDOWN = `# Working with Dispatch tasks

Dispatch tracks work as markdown files under \`.dispatch/tasks/\`, one file per
task, synced by git. This server gives you tools to read and write those files
safely — you never need to edit them directly, though you can if you want to
(they're just files: \`<id>-<slug>.md\` with YAML frontmatter and a body).

## Ids

Task ids look like \`t-1a2b3c\` (tasks) or \`e-1a2b3c\` (epics) — a one-letter
kind prefix, a hyphen, six hex characters. Ids are assigned on creation and
never change.

## The ready-work loop

1. Call \`task_next\` to see tasks that are unblocked and ready to start (kind
   \`task\`, status \`todo\`, every entry in \`blockedBy\` already done),
   priority-ordered.
2. Pick one, do the work.
3. Call \`task_comment\` as you make progress — it appends a timestamped line
   to the task's Activity log, so anyone (human or agent) reading the file
   later can follow what happened.
4. Call \`task_save\` with the task's \`id\` and \`status\` to move it forward
   (e.g. \`in-progress\`, then \`done\`).

## Statuses are config-driven

The built-in statuses are \`backlog\`, \`todo\`, \`in-progress\`, \`in-review\`,
\`done\`, \`cancelled\`, but a given repo's \`.dispatch/config.yml\` can define a
different set — that file is always the source of truth. \`task_list\` and
\`task_save\` validate \`status\` against it, not against this list.

## Creating and updating tasks

- \`task_save\` with no \`id\` creates a task (\`title\` is required).
- \`task_save\` with an \`id\` updates only the fields you pass — omitted fields
  are left untouched. \`kind\` and \`description\` only take effect on create;
  there's no supported way to change a task's kind or rewrite its description
  section after creation via this tool. Use \`task_comment\` (or edit the file
  directly) for progress notes and body-level updates instead.
- \`blockedBy\` and \`labels\` are full replacements on update, not additive.

## Direct file access

Every task is a plain markdown file, so if a tool here doesn't cover what you
need, reading or editing files under \`.dispatch/tasks/\` directly is always a
valid fallback — just keep the YAML frontmatter's required fields (\`id\`,
\`title\`, \`status\`, \`kind\`, \`created\`, \`updated\`) intact.
`;
