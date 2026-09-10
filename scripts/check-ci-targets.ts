#!/usr/bin/env bun
// Fails unless every root-project task that is *meant* to gate CI is actually
// named in .github/workflows/ci.yml's `moon ci` target list.
//
// This exists because the two are independent bookkeeping and nothing tied
// them together. `moon ci` given an explicit target list runs ONLY those
// targets — a root task with `runInCI: 'always'` that nobody added to the list
// is simply never run, and there is no error, no warning, and no way to notice
// except by reading both files side by side. That is not hypothetical: before
// this migration the repo had eight lint scripts and CI invoked four of them,
// so lint-dup, lint-arch, lint-spelling, lint-md, lint-types and lint-chrome
// had been dark for months while the badge stayed green.
//
// The opt-out is deliberate and narrow: a task that should exist but not gate
// CI lists itself in EXPECTED_ABSENT with a reason.
//
// The same drift exists on a second axis: the merge queue verifies each run
// with `.dispatch/config.yml`'s verifySteps before squash-merging it, and that
// list is bookkeeping independent of ci.yml too. On 2026-09-08 it was
// install/build/lint/test while CI gated on fourteen root tasks, so four runs
// verified green and then turned main red on gates verify had never run. So
// every root target ci.yml names must also appear in verifySteps.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(repoRoot, '.github/workflows/ci.yml');
const verifyConfigPath = resolve(repoRoot, '.dispatch/config.yml');

// Root tasks that are CI-eligible but intentionally not gates.
const EXPECTED_ABSENT = new Map<string, string>([
  [
    'format',
    'Rewrites the tree. CI gates on format-check instead; this stays CI-eligible only so agent shells (where CI is set) can run the documented `moon run root:format` baseline.',
  ],
  [
    'audit-full',
    'Informational. ci.yml runs `pnpm audit` directly with continue-on-error so the high/moderate backlog stays visible without blocking.',
  ],
]);

// The `moon ci` invocation is a YAML folded scalar spanning several lines, so
// read the whole file and pull every `root:<task>` token out of it.
//
// Anchored on the `run:` line that actually starts with `moon ci`, NOT on the
// first occurrence of the string: the step is preceded by a comment that
// mentions `moon ci` in prose, and matching that gave an empty target set and
// a guard that passed no matter what (found the hard way — all three mutation
// cases "passed" against zero targets).
function targetsInWorkflow(): Set<string> {
  const text = readFileSync(workflowPath, 'utf8');
  const runLine = /^\s*run: >-\n\s*moon ci\b/m.exec(text);
  if (runLine === null) {
    console.error(
      `No \`run: >-\` block invoking \`moon ci\` found in ${workflowPath}.`
    );
    process.exit(1);
  }
  // Stop at the next step (a line beginning with `      - name:`).
  const rest = text.slice(runLine.index);
  const end = rest.search(/\n {6}- name:/);
  const block = end === -1 ? rest : rest.slice(0, end);
  const targets = new Set(
    [...block.matchAll(/\broot:([a-z0-9-]+)/g)].map((m) => m[1])
  );
  if (targets.size === 0) {
    console.error(
      `Parsed the \`moon ci\` step in ${workflowPath} but found no root: targets. The parser is out of step with the workflow.`
    );
    process.exit(1);
  }
  return targets;
}

// Root targets the merge queue's verify runs, pulled from the `verifySteps:`
// block of .dispatch/config.yml the same way the workflow is read: scan the
// block for `root:<task>` tokens rather than parsing YAML, and stop at the
// next top-level key so a comment elsewhere in the file cannot satisfy it.
function targetsInVerifySteps(): Set<string> {
  const text = readFileSync(verifyConfigPath, 'utf8');
  const start = /^verifySteps:/m.exec(text);
  if (start === null) {
    console.error(
      `No \`verifySteps:\` block found in ${verifyConfigPath}; the merge queue would verify nothing.`
    );
    process.exit(1);
  }
  const rest = text.slice(start.index + 'verifySteps:'.length);
  const end = rest.search(/^[A-Za-z]/m);
  const block = end === -1 ? rest : rest.slice(0, end);
  // Only `command:` lines count — a step's name is free text.
  const targets = new Set<string>();
  for (const line of block.split('\n')) {
    if (!/^\s*command:/.test(line)) continue;
    for (const m of line.matchAll(/\broot:([a-z0-9-]+)/g)) targets.add(m[1]);
  }
  return targets;
}

// Root tasks moon would consider running in CI, straight from the task graph.
function ciEligibleRootTasks(): Map<string, boolean> {
  // No --id filter: that matches TASK ids, not projects, and silently returns
  // an empty set (which made this guard vacuous once already). Query
  // everything and index the root project out of it.
  const res = spawnSync('moon', ['query', 'tasks'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    console.error(`\`moon query tasks\` failed:\n${res.stderr}`);
    process.exit(1);
  }
  const parsed = JSON.parse(res.stdout) as {
    tasks: Record<
      string,
      Record<string, { options?: Record<string, unknown> }>
    >;
  };
  const rootTasks = parsed.tasks?.root ?? {};
  if (Object.keys(rootTasks).length === 0) {
    console.error(
      'moon reported no tasks for the `root` project. Either the query shape changed or the root moon.yml is not being picked up; refusing to pass vacuously.'
    );
    process.exit(1);
  }
  const out = new Map<string, boolean>();
  for (const [name, task] of Object.entries(rootTasks)) {
    const runInCI = task.options?.runInCI;
    const interactive = task.options?.interactive === true;
    const internal = task.options?.internal === true;
    const eligible =
      runInCI !== 'skip' && runInCI !== false && !interactive && !internal;
    out.set(name, eligible);
  }
  return out;
}

const listed = targetsInWorkflow();
const eligible = ciEligibleRootTasks();
const problems: string[] = [];

for (const [name, isEligible] of eligible) {
  if (!isEligible || listed.has(name) || EXPECTED_ABSENT.has(name)) continue;
  problems.push(
    `root:${name} runs in CI but is missing from ci.yml's \`moon ci\` target list, so CI never runs it. Add it there, or add it to EXPECTED_ABSENT in this script with a reason.`
  );
}

for (const name of listed) {
  if (!eligible.has(name)) {
    problems.push(
      `ci.yml names root:${name}, but no such task exists on the root project. \`moon ci\` will fail.`
    );
  } else if (eligible.get(name) === false) {
    problems.push(
      `ci.yml names root:${name}, but that task is skipped in CI (runInCI/interactive/internal), so naming it there is misleading.`
    );
  }
}

const verified = targetsInVerifySteps();
for (const name of listed) {
  if (verified.has(name)) continue;
  problems.push(
    `root:${name} gates CI but is missing from verifySteps in .dispatch/config.yml, so a run can verify green and still turn main red. Add a step running \`moon run root:${name}\`.`
  );
}
for (const name of verified) {
  if (!eligible.has(name)) {
    problems.push(
      `.dispatch/config.yml's verifySteps names root:${name}, but no such task exists on the root project.`
    );
  }
}

for (const name of EXPECTED_ABSENT.keys()) {
  if (listed.has(name)) {
    problems.push(
      `root:${name} is in EXPECTED_ABSENT but ci.yml now names it. Remove it from EXPECTED_ABSENT.`
    );
  }
}

if (problems.length > 0) {
  console.error('CI target check failed:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `CI target check passed: ci.yml gates on all ${listed.size} root tasks that run in CI, and verifySteps runs every one of them.`
);
