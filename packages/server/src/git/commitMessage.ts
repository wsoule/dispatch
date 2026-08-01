import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig } from '@dispatch/core';

import { openClaudeQuery } from '../orchestrator/claudeCli.js';

// Generates a Conventional Commits message from a staged diff, mirroring
// InboxClusterer's invocation shape (Haiku-class model, no tools).

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['message'],
  properties: {
    message: { type: 'string' },
  },
} as const;

/** Bounds a single generation call the same way InboxClusterer bounds a cluster pass. */
const COMMIT_MESSAGE_TIMEOUT_MS = 60_000;

// Caps what reaches the model — one staged lockfile could blow the context.
const MAX_DIFF_CHARS = 20_000;

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' ||
      err.message.includes('FetchRequestCanceledException'))
  );
}

function buildPrompt(diff: string): string {
  const truncated = diff.length > MAX_DIFF_CHARS;
  const diffText = truncated
    ? `${diff.slice(0, MAX_DIFF_CHARS)}\n... (diff truncated)`
    : diff;
  return [
    'Write a git commit message for the staged changes below, in Conventional ' +
      'Commits form (`type(scope): subject`).',
    `Diff of staged changes:\n${diffText}`,
    'Return only the commit message: a single-line subject, optionally followed ' +
      'by a blank line and a short body. No commentary, no markdown fences.',
  ].join('\n\n');
}

export class CommitMessageGenerator {
  constructor(
    private readonly rootDir: string,
    private readonly queryFn: typeof query = query
  ) {}

  async generate(diff: string): Promise<string> {
    const abortController = new AbortController();
    const timer = setTimeout(
      () => abortController.abort(),
      COMMIT_MESSAGE_TIMEOUT_MS
    );
    try {
      const options: Options = {
        cwd: this.rootDir,
        model: loadConfig(this.rootDir).models.summarize,
        permissionMode: 'plan',
        allowedTools: [],
        outputFormat: { type: 'json_schema', schema: SCHEMA },
        abortController,
      };
      const sdkQuery: Query = openClaudeQuery(
        this.queryFn,
        buildPrompt(diff),
        options
      );
      for await (const message of sdkQuery) {
        if (message.type !== 'result') continue;
        if (message.subtype !== 'success') {
          throw new Error(
            `commit message generation failed: ${message.subtype}`
          );
        }
        if (message.structured_output === undefined) {
          throw new Error(
            'commit message generation returned no structured output'
          );
        }
        const parsed = message.structured_output as { message?: string };
        return typeof parsed.message === 'string' ? parsed.message.trim() : '';
      }
      return '';
    } catch (err) {
      if (isAbortError(err)) {
        throw new Error(
          `commit message generation timed out after ${COMMIT_MESSAGE_TIMEOUT_MS / 1000}s`
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
