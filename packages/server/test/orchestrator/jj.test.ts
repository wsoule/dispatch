import { describe, expect, it } from 'bun:test';

import { JjManager } from '../../src/orchestrator/jj.js';
import type { CommandResult } from '../../src/orchestrator/pr.js';

// Records every command a JjManager issues and replays canned results, so
// these tests assert the exact jj invocations without needing a real repo.
function fakeRunner(results: Record<string, CommandResult>) {
  const calls: string[][] = [];
  const run = (_cwd: string, cmd: string[]): Promise<CommandResult> => {
    calls.push(cmd);
    const key = cmd.join(' ');
    return Promise.resolve(
      results[key] ?? { ok: true, stdout: '', stderr: '' }
    );
  };
  return { calls, run };
}

describe('JjManager', () => {
  it('reports availability from `jj --version`', async () => {
    const missing = fakeRunner({
      'jj --version': { ok: false, stdout: '', stderr: 'command not found' },
    });
    expect(await new JjManager('/repo', missing.run).isAvailable()).toBe(false);

    const present = fakeRunner({
      'jj --version': { ok: true, stdout: 'jj 0.43.0\n', stderr: '' },
    });
    expect(await new JjManager('/repo', present.run).isAvailable()).toBe(true);
  });

  it('reports colocation from `jj git colocation status`', async () => {
    const no = fakeRunner({
      'jj git colocation status': {
        ok: false,
        stdout: '',
        stderr: 'There is no jj repo in "."',
      },
    });
    expect(await new JjManager('/repo', no.run).isColocated()).toBe(false);
  });

  it('ensureColocated is a no-op when already colocated', async () => {
    const f = fakeRunner({
      'jj --version': { ok: true, stdout: 'jj 0.43.0', stderr: '' },
      'jj git colocation status': { ok: true, stdout: 'colocated', stderr: '' },
    });
    expect(await new JjManager('/repo', f.run).ensureColocated()).toBe(true);
    expect(f.calls.map((c) => c.join(' '))).not.toContain(
      'jj git init --colocate'
    );
  });

  it('ensureColocated initializes a plain-git repo', async () => {
    const f = fakeRunner({
      'jj --version': { ok: true, stdout: 'jj 0.43.0', stderr: '' },
      'jj git colocation status': {
        ok: false,
        stdout: '',
        stderr: 'no jj repo',
      },
    });
    expect(await new JjManager('/repo', f.run).ensureColocated()).toBe(true);
    expect(f.calls.map((c) => c.join(' '))).toContain('jj git init --colocate');
  });

  it('ensureColocated returns false when jj is missing, without running anything else', async () => {
    const f = fakeRunner({
      'jj --version': { ok: false, stdout: '', stderr: 'not found' },
    });
    expect(await new JjManager('/repo', f.run).ensureColocated()).toBe(false);
    expect(f.calls).toHaveLength(1);
  });

  it('restackOnto moves only the dependent commits and skips emptied ones', async () => {
    const f = fakeRunner({});
    await new JjManager('/repo', f.run).restackOnto(
      'dispatch/t-b',
      'abc1234',
      'main'
    );
    expect(f.calls.map((c) => c.join(' '))).toEqual([
      'jj rebase -s roots(abc1234..dispatch/t-b) -d main --skip-emptied',
      'jj git export',
    ]);
  });

  it('restack rebases the branch and exports refs back to git', async () => {
    const f = fakeRunner({});
    await new JjManager('/repo', f.run).restack('dispatch/t-b', 'main');
    expect(f.calls.map((c) => c.join(' '))).toEqual([
      'jj rebase -b dispatch/t-b -d main',
      'jj git export',
    ]);
  });

  it('restack throws with jj stderr when the rebase fails', async () => {
    const f = fakeRunner({
      'jj rebase -b dispatch/t-b -d main': {
        ok: false,
        stdout: '',
        stderr: 'no such revision',
      },
    });
    await expect(
      new JjManager('/repo', f.run).restack('dispatch/t-b', 'main')
    ).rejects.toThrow('no such revision');
  });

  it('mergeBase creates a multi-parent commit and bookmarks it', async () => {
    const f = fakeRunner({});
    const ref = await new JjManager('/repo', f.run).mergeBase(
      ['dispatch/a', 'dispatch/c'],
      'dispatch/stack-base-t-d00000'
    );
    expect(ref).toBe('dispatch/stack-base-t-d00000');
    expect(f.calls.map((c) => c.join(' '))).toEqual([
      'jj new -r dispatch/a -r dispatch/c',
      'jj bookmark create dispatch/stack-base-t-d00000 -r @',
      'jj git export',
    ]);
  });

  it('mergeBase rejects fewer than two parents', async () => {
    const f = fakeRunner({});
    await expect(
      new JjManager('/repo', f.run).mergeBase(['dispatch/a'], 'dispatch/b')
    ).rejects.toThrow('at least two parents');
  });
});
