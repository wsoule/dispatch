import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import { DEFAULT_REPO_DIGEST } from '@dispatch/core';
import type { RepoDigestConfig } from '@dispatch/core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { openClaudeQuery, rewriteMissingCliError } from './claudeCli.js';
import { runsDir } from './paths.js';

/**
 * A written-once orientation map of the repository: what each subsystem is,
 * where the seams are, which files a change usually starts from. Cached because
 * generating it costs an LLM call, and keyed by the commit it was written
 * against so a reader can tell how stale it is.
 */
export interface RepoDigest {
  /** The HEAD sha this was generated against. */
  commit: string;
  generatedAt: string;
  markdown: string;
  /** What the generating call cost, when the SDK reported it. */
  costUsd?: number;
}

// Where the cache lives — beside the transcripts, since it is per-project state
// that must outlive any individual run's worktree (same reasoning as
// paths.ts's mergeQueuePath).
export function repoDigestPath(rootDir: string): string {
  return join(runsDir(rootDir), 'repo-digest.json');
}

// Rendered into every run prompt, so it has to stay short enough to be worth
// its tokens. This is a ceiling on a generator that ignores its instructions,
// not a target.
const MAX_DIGEST_CHARS = 6000;

// Deliberately far shorter than the success cooldown. Retrying a transient
// failure quickly is the intent; this only stops it happening every dispatch.
const FAILED_ATTEMPT_BACKOFF_MS = 5 * 60 * 1000;

const DIGEST_PROMPT =
  'Write a concise orientation map of this repository for an engineer who is ' +
  'about to make a change in it and has never seen it before. Cover: what ' +
  'each top-level package/app is for and how they depend on each other; the ' +
  'two or three seams where most changes land, named by file path; the ' +
  'conventions a change has to follow that are not obvious from a single ' +
  'file; and anything structurally surprising. Be specific and name real ' +
  'paths — a list of directory names is worthless. Do not describe how to ' +
  'run tests or lint (the reader is told that separately). Output GitHub ' +
  'markdown under 400 words, no preamble, starting directly with the content.';

// Reads the cached digest, treating a missing, unreadable, or shapeless file as
// "nothing cached yet" rather than throwing — same tolerance as MergeQueue's
// loadPersistedFile, and for the same reason: this is on the dispatch path.
export function readRepoDigest(rootDir: string): RepoDigest | null {
  const path = repoDigestPath(rootDir);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.commit !== 'string' ||
      typeof record.generatedAt !== 'string' ||
      typeof record.markdown !== 'string' ||
      record.markdown === ''
    ) {
      return null;
    }
    return {
      commit: record.commit,
      generatedAt: record.generatedAt,
      markdown: record.markdown,
      // Omitted rather than defaulted: a record written before costs were
      // tracked has no cost, which is not the same as a cost of zero.
      ...(typeof record.costUsd === 'number' && Number.isFinite(record.costUsd)
        ? { costUsd: record.costUsd }
        : {}),
    };
  } catch {
    return null;
  }
}

export function writeRepoDigest(rootDir: string, digest: RepoDigest): void {
  const path = repoDigestPath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(digest, null, 2)}\n`);
}

// The project's current HEAD, or null when rootDir isn't a git checkout (or git
// is unavailable). Mirrors Orchestrator.currentBranch's own spawnSync shape
// rather than reaching into WorktreeManager, whose runGit is module-private.
export function headCommit(rootDir: string): string | null {
  try {
    const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
      cwd: rootDir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode !== 0) return null;
    const sha = result.stdout.toString('utf8').trim();
    return sha === '' ? null : sha;
  } catch {
    return null;
  }
}

/** What one generation produced: the map, and what it cost when the SDK said. */
export interface DigestResult {
  markdown: string;
  /** null when the result message carried no cost. */
  costUsd: number | null;
}

/** Generates the digest for a checkout. Injectable so tests never reach the
 * real model. */
export type DigestGenerator = (rootDir: string) => Promise<DigestResult>;

// The real generator: one read-only Agent SDK turn against the main checkout,
// configured exactly like ClaudePlanner's (plan permissions so no tool
// executes, and settingSources so the repo's own AGENTS.md/CLAUDE.md ground
// the answer).
export async function generateRepoDigest(
  rootDir: string,
  queryFn: typeof query = query
): Promise<DigestResult> {
  const options: Options = {
    cwd: rootDir,
    permissionMode: 'plan',
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['user', 'project', 'local'],
  };
  const sdkQuery: Query = openClaudeQuery(queryFn, DIGEST_PROMPT, options);
  try {
    for await (const message of sdkQuery) {
      if (message.type !== 'result') continue;
      if (message.subtype !== 'success') {
        throw new Error(`repo digest failed: ${message.subtype}`);
      }
      return {
        markdown: message.result,
        costUsd:
          typeof message.total_cost_usd === 'number'
            ? message.total_cost_usd
            : null,
      };
    }
    throw new Error('repo digest produced no result message');
  } catch (err) {
    throw new Error(rewriteMissingCliError((err as Error).message));
  }
}

/** Whether a dispatch should pay for a fresh digest.
 *
 * Time, not HEAD equality, is the gate: a digest is an orientation map rather
 * than an index, so one written a few commits ago is nearly as useful as one
 * written now — and every merge-queue merge moves HEAD, so keying on equality
 * alone bought a full-repo read per merge. */
export function shouldRegenerate(
  cached: RepoDigest | null,
  head: string,
  now: Date,
  config: RepoDigestConfig
): boolean {
  if (!config.enabled) return false;
  // No digest at all is the case the feature exists for, so the cooldown must
  // not gate it.
  if (cached === null) return true;
  if (cached.commit === head) return false;
  const writtenAt = Date.parse(cached.generatedAt);
  // A corrupt timestamp counts as infinitely old, so it regenerates rather
  // than wedging the cache shut.
  if (Number.isNaN(writtenAt)) return true;
  return now.getTime() - writtenAt >= config.cooldownHours * 60 * 60 * 1000;
}

/**
 * Serves the cached repo digest to prompt construction and keeps it current in
 * the background.
 *
 * `current()` never blocks and never throws: it hands back whatever is cached
 * (even a digest written several commits ago, which the prompt labels with its
 * commit so the agent can weigh it) and, when that is missing or stale,
 * schedules a regeneration for a *later* run to benefit from. Blocking the
 * dispatch path on an LLM call to save an agent some file reads would trade a
 * cheap problem for an expensive one, and a first run in a fresh project would
 * sit in `provisioning` waiting on the model.
 *
 * `generate` is deliberately NOT defaulted to the real model. Constructed bare,
 * this serves the cache and never generates — so every test that dispatches a
 * run gets orientation without spawning a Claude CLI process. Production wires
 * `generateRepoDigest` in explicitly at daemon boot (index.ts), the same split
 * ClaudePlanner/FakePlanner already use.
 */
export class RepoDigestCache {
  // Single-flight: `current()` is called once per dispatch, and several runs
  // dispatched together would otherwise each start their own generation.
  private refreshing = false;

  // In memory, not on disk: a daemon restart usually means the operator just
  // fixed what was broken and should get an immediate retry.
  private lastAttemptAt: number | null = null;

  constructor(
    private readonly rootDir: string,
    private readonly generate?: DigestGenerator,
    // Read per call rather than frozen at construction, so a config edit
    // applies without a daemon restart — same as Orchestrator.orchestratorCaps.
    private readonly readConfig: () => RepoDigestConfig = () => ({
      ...DEFAULT_REPO_DIGEST,
    })
  ) {}

  current(): RepoDigest | null {
    const cached = readRepoDigest(this.rootDir);
    if (this.generate === undefined) return cached;
    const head = headCommit(this.rootDir);
    // A null head means we can't tell fresh from stale, so we serve what we
    // have and don't burn a model call guessing.
    if (
      head !== null &&
      shouldRegenerate(cached, head, new Date(), this.readConfig())
    ) {
      this.refresh(head);
    }
    return cached;
  }

  /** Clears the failure backoff so a test can reach past it without sleeping. */
  forgetLastAttemptForTest(): void {
    this.lastAttemptAt = null;
  }

  // Fire-and-forget. A failure logs and clears the flag so a transient one (no
  // CLI on PATH, a model error) is retried rather than wedging the cache shut
  // for the life of the daemon — but only once the backoff has passed, since a
  // failed generation writes nothing for the cooldown to read.
  private refresh(commit: string): void {
    const generate = this.generate;
    if (generate === undefined || this.refreshing) return;
    if (
      this.lastAttemptAt !== null &&
      Date.now() - this.lastAttemptAt < FAILED_ATTEMPT_BACKOFF_MS
    ) {
      return;
    }
    this.lastAttemptAt = Date.now();
    this.refreshing = true;
    void generate(this.rootDir)
      .then((result) => {
        const trimmed = result.markdown.trim();
        if (trimmed === '') return;
        writeRepoDigest(this.rootDir, {
          commit,
          generatedAt: new Date().toISOString(),
          markdown: trimmed.slice(0, MAX_DIGEST_CHARS),
          ...(result.costUsd !== null ? { costUsd: result.costUsd } : {}),
        });
        console.log(
          `dispatchd: regenerated repo digest for ${commit.slice(0, 7)} (${
            result.costUsd !== null
              ? `$${result.costUsd.toFixed(4)}`
              : 'cost unreported'
          })`
        );
      })
      .catch((err: unknown) => {
        console.error(
          `dispatchd: could not refresh the repo digest: ${(err as Error).message}`
        );
      })
      .finally(() => {
        this.refreshing = false;
      });
  }
}
