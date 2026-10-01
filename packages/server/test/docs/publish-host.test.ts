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
    // A path is matched literally, never as a glob or pathspec magic.
    expect(host.lastCommitFor('docs/*.md')).toBeNull();
    expect(host.lastCommitFor(':(glob)docs/*.md')).toBeNull();
  });
});

describe('closePublishTask', () => {
  it('drops the task with the reason in its activity', () => {
    const updates: { id: string; patch: Record<string, unknown> }[] = [];
    const host = new DaemonDocsHost({
      store: {
        update: (id: string, patch: Record<string, unknown>) => {
          updates.push({ id, patch });
          return { meta: { id } };
        },
      } as never,
      events,
    });
    host.closePublishTask('t-pub', 'path became a symlink');
    expect(updates).toEqual([
      {
        id: 't-pub',
        patch: expect.objectContaining({
          status: 'dropped',
          appendActivity: expect.stringContaining('path became a symlink'),
          activityActor: 'none',
        }),
      },
    ]);
  });
});

describe('publishOutcome', () => {
  // A real repo: main holds a commit that wrote docs/spec.md and one that did not;
  // a side branch holds another that wrote it but never reached main.
  function repoWithCommits(): {
    repo: string;
    wrote: string;
    other: string;
    side: string;
  } {
    const repo = realpathSync(initGitRepo('docs-publish-land-'));
    repos.push(repo);
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'docs', 'spec.md'), 'v1\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'docs: publish spec rev 1');
    const wrote = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'other.md'), 'x\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'unrelated');
    const other = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-qb', 'side');
    writeFileSync(join(repo, 'docs', 'spec.md'), 'side\n');
    git(repo, 'commit', '-qam', 'side edit');
    const side = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    return { repo, wrote, other, side };
  }

  // A task store holding one task at `status`, and runs of it as given.
  function hostWith(
    status: string | null,
    runs: {
      taskId: string;
      kind?: string;
      reviewAction?: string;
      mergeCommit?: string;
      files?: string[];
    }[],
    rootDir?: string
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
      ...(rootDir === undefined ? {} : { rootDir }),
    });
    const listed = runs.map((r, i) => ({
      id: `r-${i}`,
      kind: 'execute',
      ...r,
    }));
    host.bindRuns({
      list: () => listed as never,
      taskIdOfRun: () => null,
      notifyRun: () => undefined,
      onRunTerminal: () => () => undefined,
      diff: (id: string) => ({
        patch: '',
        files: (listed.find((r) => r.id === id)?.files ?? []).map((path) => ({
          path,
          status: 'M',
        })),
      }),
    });
    return host;
  }

  it('lands a merge only through a merge commit on main that changed the path', () => {
    const { repo, wrote, other, side } = repoWithCommits();
    const merged = (mergeCommit?: string) =>
      hostWith(
        'landed',
        [{ taskId: 't-pub', reviewAction: 'merge', mergeCommit }],
        repo
      ).publishOutcome('t-pub', 'docs/spec.md');
    expect(merged(wrote)).toEqual({ state: 'landed', commit: wrote });
    for (const commit of [undefined, other, side]) {
      expect(merged(commit)).toEqual({
        state: 'failed',
        reason: expect.stringContaining('nothing landed'),
      });
    }
  });

  it('lands a PR merge only when the run’s merged diff changed the path', () => {
    const { repo, other } = repoWithCommits();
    const viaPr = (files: string[]) =>
      hostWith(
        'done',
        [{ taskId: 't-pub', reviewAction: 'pr', files }],
        repo
      ).publishOutcome('t-pub', 'docs/spec.md');
    expect(viaPr(['docs/spec.md'])).toMatchObject({ state: 'landed' });
    expect(viaPr(['other.md'])).toMatchObject({ state: 'failed' });
    expect(other).not.toBe('');
  });

  it('waits on a status alone, and on a review or discarded run', () => {
    expect(
      hostWith('landed', []).publishOutcome('t-pub', 'docs/spec.md')
    ).toBeNull();
    expect(
      hostWith('landed', [
        { taskId: 't-other', reviewAction: 'merge' },
        { taskId: 't-pub', kind: 'review', reviewAction: 'merge' },
        { taskId: 't-pub', reviewAction: 'discard' },
      ]).publishOutcome('t-pub', 'docs/spec.md')
    ).toBeNull();
  });

  it('is null while the task is open, and dropped once it is dropped or gone', () => {
    const merged = [{ taskId: 't-pub', reviewAction: 'merge' }];
    expect(
      hostWith('review', merged).publishOutcome('t-pub', 'docs/spec.md')
    ).toBeNull();
    expect(
      hostWith('dropped', []).publishOutcome('t-pub', 'docs/spec.md')
    ).toEqual({ state: 'dropped' });
    expect(hostWith(null, []).publishOutcome('t-pub', 'docs/spec.md')).toEqual({
      state: 'dropped',
    });
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
    expect(host.publishOutcome('t-pub', 'docs/spec.md')).toBeNull();
  });
});
