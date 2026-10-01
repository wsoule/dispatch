import { describe, expect, it } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeOrchestrator, useTempProject } from '../messaging/harness.js';
import { StallingExecutor } from './helpers.js';

const project = useTempProject();

describe('the worktree seed hook', () => {
  it('runs right after the worktree is added, before the executor starts', async () => {
    const { orchestrator, store } = makeOrchestrator(project.root());
    const executor = new StallingExecutor();
    orchestrator.registerExecutor('claude', executor);
    const seenAtSeed: number[] = [];
    orchestrator.setWorktreeSeed((taskId, wt) => {
      seenAtSeed.push(executor.started.length);
      writeFileSync(join(wt, 'seeded.md'), taskId);
    });
    const task = store.create({ title: 'Seeded' });
    const run = await orchestrator.dispatch(task.meta.id, 'claude');
    expect(seenAtSeed).toEqual([0]);
    expect(readFileSync(join(run.worktreePath, 'seeded.md'), 'utf8')).toBe(
      task.meta.id
    );
  });

  it('fails the dispatch with the reason and removes the worktree when the seed throws', async () => {
    const { orchestrator, store } = makeOrchestrator(project.root());
    const executor = new StallingExecutor();
    orchestrator.registerExecutor('claude', executor);
    orchestrator.setWorktreeSeed(() => {
      throw new Error('a path became a symlink');
    });
    const task = store.create({ title: 'Seed fails' });
    await expect(orchestrator.dispatch(task.meta.id, 'claude')).rejects.toThrow(
      'could not seed the worktree: a path became a symlink'
    );
    expect(executor.started).toEqual([]);
    expect(
      orchestrator.list().filter((r) => r.taskId === task.meta.id)
    ).toEqual([]);
    const worktrees = Bun.spawnSync(['git', 'worktree', 'list'], {
      cwd: project.root(),
    })
      .stdout.toString()
      .trim()
      .split('\n');
    expect(worktrees).toHaveLength(1);
  });
});
