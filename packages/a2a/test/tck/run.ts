import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
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

// CORE-SEND-003 says ContentTypeNotSupportedError but, at this pin, sets no
// expected_error, so the TCK's runner fails any error and passes only a send
// that succeeds. Restore the file, then make it expect the error it names.
const REQUIREMENTS = 'tck/requirements/core_operations.py';
await run(['git', '-C', dir, 'checkout', '--quiet', '--', REQUIREMENTS]);
const requirementsPath = resolve(dir, REQUIREMENTS);
const requirements = readFileSync(requirementsPath, 'utf8');
const patched = requirements
  .replace(
    '    EXTENSION_SUPPORT_REQUIRED_ERROR,\n',
    '    CONTENT_TYPE_NOT_SUPPORTED_ERROR,\n    EXTENSION_SUPPORT_REQUIRED_ERROR,\n'
  )
  .replace(
    '        expected_behavior="ContentTypeNotSupportedError returned",\n',
    '        expected_behavior="ContentTypeNotSupportedError returned",\n        expected_error=CONTENT_TYPE_NOT_SUPPORTED_ERROR,\n'
  );
if (
  patched.split('CONTENT_TYPE_NOT_SUPPORTED_ERROR').length !== 3 ||
  !patched.includes('tck_id("send-003")')
) {
  console.error(
    `a2a-tck: ${REQUIREMENTS} changed; revisit the CORE-SEND-003 patch`
  );
  process.exit(1);
}
writeFileSync(requirementsPath, patched);

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
