import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DaemonDocsHost } from '../../src/docs/host.js';
import { initGitRepo } from '../orchestrator/helpers.js';

const repos: string[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const res = Bun.spawnSync({
    cmd: ['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    cwd,
  });
  if (res.exitCode !== 0)
    throw new Error(`git ${args.join(' ')}: ${res.stderr.toString()}`);
  return res.stdout.toString().trim();
}

const events = { broadcast: () => undefined } as never;

describe('lastCommitFor', () => {
  it('names the newest commit on the default branch that touched the path', () => {
    const repo = realpathSync(initGitRepo('docs-publish-git-'));
    repos.push(repo);
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'docs', 'spec.md'), 'v1\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'docs: publish spec rev 1');
    const published = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'other.md'), 'x\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'unrelated');
    // A commit on another branch never counts: only the default branch landed.
    git(repo, 'checkout', '-qb', 'side');
    writeFileSync(join(repo, 'docs', 'spec.md'), 'side\n');
    git(repo, 'commit', '-qam', 'side edit');
    git(repo, 'checkout', '-q', 'main');
    const host = new DaemonDocsHost({
      store: {} as never,
      events,
      rootDir: repo,
    });
    expect(host.lastCommitFor('docs/spec.md')).toBe(published);
    expect(host.lastCommitFor('docs/never.md')).toBeNull();
  });
});

describe('publishOutcome', () => {
  // A task store holding one task at `status`, and runs of it as given.
  function hostWith(
    status: string | null,
    runs: { taskId: string; kind?: string; reviewAction?: string }[]
  ): DaemonDocsHost {
    const host = new DaemonDocsHost({
      store: {
        get: (id: string) =>
          id === 't-pub' && status !== null
            ? {
                meta: {
                  title: 'x',
                  status,
                  parent: null,
                  risk: 'elevated',
                  labels: [],
                },
                body: '',
              }
            : null,
      } as never,
      events,
    });
    host.bindRuns({
      list: () =>
        runs.map((r, i) => ({ id: `r-${i}`, kind: 'execute', ...r })) as never,
      taskIdOfRun: () => null,
      notifyRun: () => undefined,
      onRunTerminal: () => () => undefined,
    });
    return host;
  }

  it('counts a landing only when one of the task’s execute runs really merged', () => {
    expect(hostWith('landed', []).publishOutcome('t-pub')).toBeNull();
    expect(
      hostWith('landed', [
        { taskId: 't-other', reviewAction: 'merge' },
      ]).publishOutcome('t-pub')
    ).toBeNull();
    expect(
      hostWith('landed', [
        { taskId: 't-pub', kind: 'review', reviewAction: 'merge' },
        { taskId: 't-pub', reviewAction: 'discard' },
      ]).publishOutcome('t-pub')
    ).toBeNull();
    expect(
      hostWith('landed', [
        { taskId: 't-pub', reviewAction: 'merge' },
      ]).publishOutcome('t-pub')
    ).toBe('landed');
    expect(
      hostWith('done', [
        { taskId: 't-pub', reviewAction: 'pr' },
      ]).publishOutcome('t-pub')
    ).toBe('landed');
  });

  it('is null while the task is open, and dropped once it is dropped or gone', () => {
    const merged = [{ taskId: 't-pub', reviewAction: 'merge' }];
    expect(hostWith('review', merged).publishOutcome('t-pub')).toBeNull();
    expect(hostWith('dropped', []).publishOutcome('t-pub')).toBe('dropped');
    expect(hostWith(null, []).publishOutcome('t-pub')).toBe('dropped');
  });

  it('is null before runs bind, whatever the status says', () => {
    const host = new DaemonDocsHost({
      store: {
        get: () => ({
          meta: {
            title: 'x',
            status: 'landed',
            parent: null,
            risk: 'elevated',
            labels: [],
          },
          body: '',
        }),
      } as never,
      events,
    });
    expect(host.publishOutcome('t-pub')).toBeNull();
  });
});
