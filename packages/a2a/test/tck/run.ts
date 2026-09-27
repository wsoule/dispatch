import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { startSut } from './sut.js';

// Clones the official A2A TCK at a pinned commit and runs its MUST level
// against the SUT in this process; Bun.spawn, since spawnSync would block the SUT.
const TCK_SHA = '263b9cfaf16a554bdfb166a7ba5b67716e946349';
const repo = resolve(import.meta.dir, '../../../..');
const dir = resolve(repo, '.agents/ignore/a2a-tck');

async function run(cmd: string[], cwd = repo): Promise<number> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' });
  return await proc.exited;
}

if (!existsSync(dir)) {
  mkdirSync(resolve(dir, '..'), { recursive: true });
  if (
    (await run([
      'git',
      'clone',
      '--quiet',
      'https://github.com/a2aproject/a2a-tck.git',
      dir,
    ])) !== 0
  )
    process.exit(1);
}
await run(['git', '-C', dir, 'fetch', '--quiet', 'origin', TCK_SHA]);
if (
  (await run([
    'git',
    '-C',
    dir,
    'checkout',
    '--quiet',
    '--detach',
    TCK_SHA,
  ])) !== 0
)
  process.exit(1);

const sut = startSut();
const code = await run(
  [
    'uv',
    'run',
    './run_tck.py',
    '--sut-host',
    `http://127.0.0.1:${sut.port}`,
    '--transport',
    'http_json',
    '--level',
    'must',
  ],
  dir
);
await sut.stop();
if (existsSync(resolve(dir, 'reports/compatibility.json'))) {
  cpSync(
    resolve(dir, 'reports/compatibility.json'),
    resolve(repo, '.agents/ignore/a2a-tck-compatibility.json')
  );
}
process.exit(code);
