import { afterAll, describe, expect, it } from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { editLoop, importFiles } from '../src/commands/docs.js';
import type { DocsApi } from '../src/docsApi.js';

// A DocsApi whose saveBody answers a scripted sequence and records what it got.
function fakeApi(
  outcomes: ('conflict' | 'base-changed' | 'saved' | 'proposed')[]
) {
  const saves: { baseRev: string | number; baseHash?: string; body: string }[] =
    [];
  let seals = 0;
  const api = {
    get: () =>
      Promise.resolve({
        doc: { handle: 'spec' },
        rev: { id: 'rev-1', n: 1, hash: 'h1' },
        text: 'original\n',
      }),
    saveBody: (
      _ref: string,
      input: { baseRev: string | number; baseHash?: string; body: string }
    ) => {
      saves.push(input);
      const next = outcomes.shift();
      if (next === 'base-changed') {
        // The head was amended in place, so only its body comes back.
        return Promise.resolve({
          ok: false as const,
          conflict: {
            code: 'conflict',
            reason: 'base-changed',
            head: {
              id: 'rev-1',
              n: 1,
              hash: 'h1b',
              body: 'original\ndesktop line\n',
              author: 'human:wyat',
            },
            base: null,
            hunks: [],
            marked: 'original\ndesktop line\n',
          },
        });
      }
      if (next === 'conflict') {
        return Promise.resolve({
          ok: false as const,
          conflict: {
            code: 'conflict',
            reason: 'merge-conflict',
            head: {
              id: 'rev-2',
              n: 2,
              hash: 'h2',
              body: 'theirs\n',
              author: 'run:r-1',
            },
            base: { id: 'rev-1', n: 1 },
            hunks: [],
            marked:
              '<<<<<<< head (rev 2, run:r-1)\ntheirs\n=======\nmine\n>>>>>>> yours\n',
          },
        });
      }
      return Promise.resolve({
        ok: true as const,
        result: {
          handle: 'spec',
          rev: { id: 'rev-3', n: 3, hash: 'h3' },
          status: next === 'proposed' ? 'proposed' : 'saved',
          proposal: 'rev-p',
          gate: 'm-g',
        },
      });
    },
    seal: () => {
      seals += 1;
      return Promise.resolve({});
    },
  } as unknown as DocsApi;
  return { api, saves, seals: () => seals };
}

const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'docs-edit-')));
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

describe('dispatch docs edit', () => {
  it('saves with base and hash, loops once on a conflict against the head, then seals', async () => {
    const { api, saves, seals } = fakeApi(['conflict', 'saved']);
    const seen: string[] = [];
    const writes = ['mine\n', 'resolved\n'];
    const result = await editLoop(api, 'spec', {
      tmpDir,
      runEditor: (path) => {
        seen.push(readFileSync(path, 'utf8'));
        // The second pass keeps the header line, as an editor that leaves it would.
        const header = seen.length === 2 ? `${seen[1].split('\n')[0]}\n` : '';
        writeFileSync(path, `${header}${writes[seen.length - 1]}`);
        return 0;
      },
      log: () => undefined,
    });
    expect(result).toBe('saved');
    expect(seen[0]).toBe('original\n');
    expect(
      seen[1].startsWith(
        '<!-- dispatch: resolve the marked blocks, then save; saving against rev 2 (rev-2) -->\n<<<<<<< head'
      )
    ).toBe(true);
    expect(saves.map((s) => [s.baseRev, s.baseHash, s.body])).toEqual([
      ['rev-1', 'h1', 'mine\n'],
      ['rev-2', 'h2', 'resolved\n'],
    ]);
    expect(seals()).toBe(1);
  });

  it('keeps what was typed beside the amended head when the base changed', async () => {
    const { api, saves } = fakeApi(['base-changed', 'saved']);
    const seen: string[] = [];
    const lines: string[] = [];
    const result = await editLoop(api, 'spec', {
      tmpDir,
      runEditor: (path) => {
        seen.push(readFileSync(path, 'utf8'));
        if (seen.length === 1) writeFileSync(path, 'original\ncli line\n');
        else writeFileSync(path, 'original\ndesktop line\ncli line\n');
        return 0;
      },
      log: (l) => lines.push(l),
    });
    expect(result).toBe('saved');
    expect(seen[1]).toBe(
      [
        '<!-- dispatch: resolve the marked blocks, then save; saving against rev 1 (rev-1) -->',
        '<<<<<<< head (rev 1, human:wyat)',
        'original',
        'desktop line',
        '=======',
        'original',
        'cli line',
        '>>>>>>> yours',
        '',
      ].join('\n')
    );
    expect(lines[0]).toContain('marked block');
    expect(saves.map((s) => [s.baseRev, s.baseHash])).toEqual([
      ['rev-1', 'h1'],
      ['rev-1', 'h1b'],
    ]);
  });

  it('loads the head alone when the base changed and nothing was typed', async () => {
    const { api } = fakeApi(['base-changed', 'saved']);
    const seen: string[] = [];
    await editLoop(api, 'spec', {
      tmpDir,
      runEditor: (path) => {
        seen.push(readFileSync(path, 'utf8'));
        if (seen.length === 2) writeFileSync(path, 'resolved\n');
        return 0;
      },
      log: () => undefined,
    });
    expect(seen[1]).toBe(
      '<!-- dispatch: resolve the marked blocks, then save; saving against rev 1 (rev-1) -->\noriginal\ndesktop line\n'
    );
  });

  it('aborts on an empty file without saving', async () => {
    const { api, saves } = fakeApi([]);
    const result = await editLoop(api, 'spec', {
      tmpDir,
      runEditor: (path) => (writeFileSync(path, '  \n'), 0),
      log: () => undefined,
    });
    expect(result).toBe('aborted');
    expect(saves).toEqual([]);
  });

  it('refuses a failed editor without saving', async () => {
    const { api, saves } = fakeApi([]);
    await expect(
      editLoop(api, 'spec', {
        tmpDir,
        runEditor: () => 1,
        log: () => undefined,
      })
    ).rejects.toThrow('the editor exited with 1');
    expect(saves).toEqual([]);
  });

  it('prints the gate when an accepted doc takes the save as a proposal', async () => {
    const { api, seals } = fakeApi(['proposed']);
    const lines: string[] = [];
    await editLoop(api, 'spec', {
      tmpDir,
      runEditor: (path) => (writeFileSync(path, 'x\n'), 0),
      log: (l) => lines.push(l),
    });
    expect(lines.join('\n')).toContain(
      'proposed for review as rev-p (gate m-g)'
    );
    expect(seals()).toBe(0);
  });
});

describe('dispatch docs import', () => {
  it('uploads only what the daemon needs, then commits', async () => {
    const a = join(tmpDir, 'a.md');
    const b = join(tmpDir, 'b.md');
    writeFileSync(a, '# A\n');
    writeFileSync(b, '# B\n');
    const calls: string[] = [];
    let manifest: { name: string; bytes: number; hash: string }[] = [];
    const api = {
      openImport: (files: typeof manifest, link?: string) => {
        manifest = files;
        calls.push(`open ${files.length} ${link ?? '-'}`);
        return Promise.resolve({ id: 'imp-1', need: [files[1].hash] });
      },
      putImportContent: (id: string, hash: string, bytes: Uint8Array) => {
        calls.push(
          `put ${id} ${hash === manifest[1].hash ? 'b' : '?'} ${new TextDecoder().decode(bytes)}`
        );
        return Promise.resolve();
      },
      commitImport: (id: string, dryRun: boolean) => {
        calls.push(`commit ${id} ${dryRun}`);
        return Promise.resolve({
          dryRun,
          parity: { files: true, names: true },
        });
      },
      deleteImport: (id: string) => {
        calls.push(`delete ${id}`);
        return Promise.resolve();
      },
    } as unknown as DocsApi;
    await importFiles(api, [a, b], { link: 'task:t-1', dryRun: true });
    expect(manifest.map((f) => [f.name, f.bytes])).toEqual([
      ['a.md', 4],
      ['b.md', 4],
    ]);
    expect(calls).toEqual([
      'open 2 task:t-1',
      'put imp-1 b # B\n',
      'commit imp-1 true',
      'delete imp-1',
    ]);
  });
});
