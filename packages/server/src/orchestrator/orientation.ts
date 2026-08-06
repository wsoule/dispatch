import { untrustedBlock, untrustedInline } from '@dispatch/core';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

import { collectHotspots } from './hotspots.js';
import type { FileHotspot } from './hotspots.js';
import { RepoDigestCache } from './repoDigest.js';
import type { RepoDigest } from './repoDigest.js';

/** One workspace package, as its own package.json describes it. */
export interface WorkspacePackage {
  /** Repo-relative directory, e.g. `packages/server`. */
  dir: string;
  /** The package.json `name`, e.g. `@dispatch/server`. */
  name: string;
  description: string | null;
}

/** One `.agents/skills/<slug>/SKILL.md`, as its frontmatter describes it. */
export interface SkillSummary {
  name: string;
  description: string;
}

/** A run already in flight, and the files it has declared or touched. */
interface ConcurrentRun {
  id: string;
  taskTitle: string;
  claims: string[];
}

/**
 * Everything a dispatched agent would otherwise spend its opening turns
 * rediscovering. Assembled by the orchestrator and rendered into the run
 * prompt, so the answers arrive with the task instead of costing a dozen tool
 * calls before the first edit.
 */
export interface RepoOrientation {
  workspaces: WorkspacePackage[];
  skills: SkillSummary[];
  /** Root package.json scripts worth knowing, in the order below. */
  scripts: { name: string; command: string }[];
  hotspots: FileHotspot[];
  digest: RepoDigest | null;
  concurrentRuns: ConcurrentRun[];
}

// The root scripts a change actually needs, in the order a contributor runs
// them. Anything else in package.json (release plumbing, hooks) is noise here.
const SCRIPTS_WORTH_LISTING = [
  'format',
  'lint',
  'lint:css',
  'tsc',
  'test',
  'build',
];

// Truncation ceilings for text that comes from files we don't control. A
// package or skill description is normally one line; these bound the damage
// from one that isn't.
const MAX_DESCRIPTION_CHARS = 240;

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// One trimmed, single-line field from a package.json or SKILL.md frontmatter.
// A description is normally one line; folding whitespace makes the multi-line
// YAML form render as one, and the cap bounds the damage from one that runs on.
function readString(
  record: Record<string, unknown>,
  key: string
): string | null {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') return null;
  const folded = value.trim().replace(/\s+/g, ' ');
  if (folded.length <= MAX_DESCRIPTION_CHARS) return folded;
  // Marked rather than silently cut, so a truncated sentence doesn't read as
  // the author's own words ending mid-thought.
  return `${folded.slice(0, MAX_DESCRIPTION_CHARS)}…`;
}

// The `dir/*` entries from Bun's `workspaces.packages`. Only that one glob
// shape is expanded — it is what this repo (and every Bun workspace convention)
// uses, and a literal path or deeper glob simply contributes no packages rather
// than being half-handled.
function workspaceGlobDirs(rootDir: string): string[] {
  const rootPkg = readJsonFile(join(rootDir, 'package.json'));
  if (rootPkg === null) return [];
  const workspaces = rootPkg.workspaces;
  const patterns = Array.isArray(workspaces)
    ? workspaces
    : typeof workspaces === 'object' &&
        workspaces !== null &&
        Array.isArray((workspaces as Record<string, unknown>).packages)
      ? ((workspaces as Record<string, unknown>).packages as unknown[])
      : [];
  return patterns
    .filter((p): p is string => typeof p === 'string' && p.endsWith('/*'))
    .map((p) => p.slice(0, -2));
}

// Every workspace package with its name and one-line purpose — the answer to
// the `ls packages apps` sweep, plus the per-package `cat package.json` reads
// that follow it.
export function collectWorkspaces(rootDir: string): WorkspacePackage[] {
  const found: WorkspacePackage[] = [];
  for (const globDir of workspaceGlobDirs(rootDir)) {
    const parent = join(rootDir, globDir);
    if (!existsSync(parent)) continue;
    let children: string[];
    try {
      children = readdirSync(parent).sort();
    } catch {
      continue;
    }
    for (const child of children) {
      const pkg = readJsonFile(join(parent, child, 'package.json'));
      if (pkg === null) continue;
      const name = readString(pkg, 'name');
      if (name === null) continue;
      found.push({
        dir: `${globDir}/${child}`,
        name,
        description: readString(pkg, 'description'),
      });
    }
  }
  return found;
}

// AGENTS.md tells every agent to list `.agents/skills/*/SKILL.md` and read each
// frontmatter description to decide what's relevant. That listing is fixed for
// a given commit, so it is rendered here once instead of being re-derived by
// every run. `.claude/skills` is a symlink to the same directory, so only one
// of the two is ever read.
export function collectSkills(rootDir: string): SkillSummary[] {
  const skillsDir = join(rootDir, '.agents', 'skills');
  if (!existsSync(skillsDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(skillsDir).sort();
  } catch {
    return [];
  }
  const skills: SkillSummary[] = [];
  for (const entry of entries) {
    const file = join(skillsDir, entry, 'SKILL.md');
    if (!existsSync(file)) continue;
    const summary = parseSkillFrontmatter(file, entry);
    if (summary !== null) skills.push(summary);
  }
  return skills;
}

// A SKILL.md opens with a `---` fenced YAML block carrying `name` and
// `description`; the description is routinely a folded multi-line scalar, which
// is why this parses real YAML rather than matching a line. A skill whose
// frontmatter is missing or unparsable falls back to its directory name, since
// knowing the skill exists still beats not listing it.
function parseSkillFrontmatter(
  file: string,
  dirName: string
): SkillSummary | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) return { name: dirName, description: '' };
  try {
    const parsed: unknown = YAML.parse(match[1]);
    if (typeof parsed !== 'object' || parsed === null) {
      return { name: dirName, description: '' };
    }
    const record = parsed as Record<string, unknown>;
    return {
      name: readString(record, 'name') ?? dirName,
      description: readString(record, 'description') ?? '',
    };
  } catch {
    return { name: dirName, description: '' };
  }
}

/** The root scripts from SCRIPTS_WORTH_LISTING that this repo actually has. */
export function collectScripts(
  rootDir: string
): { name: string; command: string }[] {
  const rootPkg = readJsonFile(join(rootDir, 'package.json'));
  if (rootPkg === null) return [];
  const scripts = rootPkg.scripts;
  if (typeof scripts !== 'object' || scripts === null) return [];
  const record = scripts as Record<string, unknown>;
  return SCRIPTS_WORTH_LISTING.filter(
    (name) => typeof record[name] === 'string'
  ).map((name) => ({ name, command: record[name] as string }));
}

export interface OrientationInput {
  rootDir: string;
  concurrentRuns: ConcurrentRun[];
  /** Shared across dispatches so its single-flight refresh actually is one. */
  digestCache?: RepoDigestCache;
}

/**
 * Gathers the whole orientation picture for one dispatch. Every collector is
 * independently best-effort, so a repo missing a package.json, a skills
 * directory, or a digest yields a smaller section rather than a failed run.
 */
export function collectOrientation(input: OrientationInput): RepoOrientation {
  return {
    workspaces: collectWorkspaces(input.rootDir),
    skills: collectSkills(input.rootDir),
    scripts: collectScripts(input.rootDir),
    hotspots: collectHotspots(input.rootDir),
    digest: (input.digestCache ?? new RepoDigestCache(input.rootDir)).current(),
    concurrentRuns: input.concurrentRuns,
  };
}

function renderWorkspaces(workspaces: WorkspacePackage[]): string[] {
  if (workspaces.length === 0) return [];
  return [
    '**Workspace packages**',
    ...workspaces.map((w) =>
      w.description === null
        ? `- \`${w.dir}\` — ${w.name}`
        : `- \`${w.dir}\` — ${w.name}: ${w.description}`
    ),
  ];
}

function renderSkills(skills: SkillSummary[]): string[] {
  if (skills.length === 0) return [];
  return [
    '**Repo skills** (`.agents/skills/<name>/SKILL.md`) — this is the full ' +
      'index; read only the ones relevant to your change, and do not list the ' +
      'directory again:',
    ...skills.map((s) =>
      s.description === ''
        ? `- \`${s.name}\``
        : `- \`${s.name}\` — ${s.description}`
    ),
  ];
}

function renderScripts(scripts: { name: string; command: string }[]): string[] {
  if (scripts.length === 0) return [];
  return [
    '**Root scripts**: ' +
      scripts.map((s) => `\`bun run ${s.name}\``).join(', '),
  ];
}

function renderHotspots(hotspots: FileHotspot[]): string[] {
  if (hotspots.length === 0) return [];
  return [
    '**Files earlier runs kept coming back to** — likely shared ground, and ' +
      'likely where your change lands too:',
    // Paths come from another run's recorded tool input, so they get the same
    // inline folding every other cross-run value in this file gets.
    ...hotspots.map(
      (h) => `- \`${untrustedInline(h.path)}\` (${h.runs} previous runs)`
    ),
  ];
}

// The digest is model-written and possibly several commits old, so it is
// labelled with the commit it was generated against and explicitly demoted
// below the code itself — an agent that trusts a stale map over the file in
// front of it is worse off than one with no map.
//
// `untrustedBlock` is not optional here. This is agent-written text landing in
// another agent's prompt — exactly what untrusted.ts exists for. The digest is
// generated by reading repo files, so a hostile file in the checkout could
// steer it into emitting a line like `## Amendments`, which buildTaskPrompt
// renders as instructions that OVERRIDE the task description. Escaping the
// structural lines keeps the map readable and stops it forging sections.
function renderDigest(digest: RepoDigest | null): string[] {
  if (digest === null) return [];
  return [
    `**Repo map** (generated at commit \`${untrustedInline(
      digest.commit.slice(0, 7)
    )}\`; the code wins wherever this disagrees with it):`,
    untrustedBlock(digest.markdown.trim()),
  ];
}

// What `run_list` would return. Rendered so the agent knows who else is in the
// repo without spending a call to ask — including the empty case, which is
// itself the answer and stops a "maybe I should check" follow-up.
function renderConcurrentRuns(runs: ConcurrentRun[]): string[] {
  if (runs.length === 0) {
    return [
      '**Other agents**: no other runs are in flight right now. Call ' +
        '`run_list` only if you need a fresher answer later in your work.',
    ];
  }
  return [
    '**Other agents in this repo right now** — treat their claimed files as ' +
      'contested ground:',
    ...runs.map((r) => {
      // Claims are task-declared `writes` globs or paths git reported — both
      // reach here from outside, so they fold inline like the title does.
      const claims =
        r.claims.length === 0
          ? 'no declared file claims'
          : r.claims.map((c) => `\`${untrustedInline(c)}\``).join(', ');
      return `- \`${untrustedInline(r.id)}\` — ${untrustedInline(r.taskTitle)} (${claims})`;
    }),
  ];
}

/**
 * Renders the orientation section injected into every run prompt, or null when
 * there was nothing worth saying (an empty repo, or a caller that collected
 * nothing) — a bare header with no facts under it is worse than no header.
 */
export function renderOrientationSection(
  orientation: RepoOrientation
): string | null {
  const repoBlocks = [
    renderDigest(orientation.digest),
    renderWorkspaces(orientation.workspaces),
    renderSkills(orientation.skills),
    renderScripts(orientation.scripts),
    renderHotspots(orientation.hotspots),
  ].filter((block) => block.length > 0);

  // The concurrency block renders unconditionally — "nobody else is running" is
  // an answer, not silence — so it can't be counted when deciding whether there
  // is anything to say. Named agents holding claims justify the section on
  // their own; the reassuring empty note does not.
  if (repoBlocks.length === 0 && orientation.concurrentRuns.length === 0) {
    return null;
  }
  const blocks = [
    ...repoBlocks,
    renderConcurrentRuns(orientation.concurrentRuns),
  ];

  return [
    '## Repo orientation',
    'Gathered for you at dispatch — these are current as of the moment your ' +
      'run started, so you do not need to rediscover them.',
    ...blocks.map((block) => block.join('\n')),
  ].join('\n\n');
}
