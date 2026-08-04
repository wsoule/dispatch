import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
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

/** Generates the digest markdown for a checkout. Injectable so tests never
 * reach the real model. */
export type DigestGenerator = (rootDir: string) => Promise<string>;

// The real generator: one read-only Agent SDK turn against the main checkout,
// configured exactly like ClaudePlanner's (plan permissions so no tool
// executes, and settingSources so the repo's own AGENTS.md/CLAUDE.md ground
// the answer).
export async function generateRepoDigest(
  rootDir: string,
  queryFn: typeof query = query
): Promise<string> {
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
      return message.result;
    }
    throw new Error('repo digest produced no result message');
  } catch (err) {
    throw new Error(rewriteMissingCliError((err as Error).message));
  }
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

  constructor(
    private readonly rootDir: string,
    private readonly generate?: DigestGenerator
  ) {}

  current(): RepoDigest | null {
    const cached = readRepoDigest(this.rootDir);
    if (this.generate === undefined) return cached;
    const head = headCommit(this.rootDir);
    // A null head means we can't tell fresh from stale, so we serve what we
    // have and don't burn a model call guessing.
    if (head !== null && (cached === null || cached.commit !== head)) {
      this.refresh(head);
    }
    return cached;
  }

  // Fire-and-forget. Every failure path logs and clears the flag so a transient
  // one (no CLI on PATH, a model error) is retried on the next dispatch rather
  // than wedging the cache shut for the life of the daemon.
  private refresh(commit: string): void {
    const generate = this.generate;
    if (generate === undefined || this.refreshing) return;
    this.refreshing = true;
    void generate(this.rootDir)
      .then((markdown) => {
        const trimmed = markdown.trim();
        if (trimmed === '') return;
        writeRepoDigest(this.rootDir, {
          commit,
          generatedAt: new Date().toISOString(),
          markdown: trimmed.slice(0, MAX_DIGEST_CHARS),
        });
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
