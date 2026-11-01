import type { NormalizedEntry } from '@dispatch/client';
import { expect, test } from 'bun:test';

import { changedFilesFromLog } from './changedFiles';

function tool(
  toolName: string,
  toolInput: Record<string, unknown>,
  status: NormalizedEntry['status'] = 'done'
): NormalizedEntry {
  return { ts: '', kind: 'tool', toolName, toolInput, status };
}

test('edits and writes fold per file, in first-touched order', () => {
  const files = changedFilesFromLog([
    tool('Edit', { file_path: 'a.ts', old_string: 'x\ny', new_string: 'z' }),
    tool('Write', { file_path: 'b.ts', content: 'one\ntwo\nthree\n' }),
    tool('Read', { file_path: 'c.ts' }),
    tool('Edit', { file_path: 'a.ts', old_string: '', new_string: 'p\nq' }),
  ]);
  expect(files).toEqual([
    { path: 'a.ts', added: 3, removed: 2 },
    { path: 'b.ts', added: 3, removed: 0 },
  ]);
});

test('failed calls and pathless calls are skipped', () => {
  expect(
    changedFilesFromLog([
      tool('Edit', { file_path: 'a.ts', new_string: 'x' }, 'error'),
      tool('Write', { content: 'x' }),
    ])
  ).toEqual([]);
});
