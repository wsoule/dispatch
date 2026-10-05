import {
  ATTACHMENT_MAX_BYTES,
  dispatchDbPath,
  TaskStore,
} from '@dispatch-foo/core';
import type { TaskStoreBackend } from '@dispatch-foo/core';
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { json } from './json.js';
import { runGitSync } from './orchestrator/helpers.js';
import { rawFetch, useTestAuth } from './testAuth.js';

// The attachment routes against a real daemon on each backend: the bytes land
// under .dispatch/attachments/<id>/, the list rides on the task's frontmatter
// or row, and every guard (size, name, auth) answers the status it promises.

function initGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  return dir;
}

function formWith(...files: File[]): FormData {
  const form = new FormData();
  for (const file of files) form.append('files', file);
  return form;
}

const BACKENDS: TaskStoreBackend[] = ['files', 'sqlite'];

for (const backend of BACKENDS) {
  describe(`attachments on the ${backend} backend`, () => {
    let root: string;
    let fakeHome: string;
    let handle: ServerHandle;
    let baseUrl: string;
    let taskId: string;
    const originalDispatchHome = process.env.DISPATCH_HOME;

    beforeEach(async () => {
      fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
      process.env.DISPATCH_HOME = fakeHome;
      root = initGitRepo('dispatch-attachments-');
      if (backend === 'files') TaskStore.init(root);
      handle = await startServer({
        rootDir: root,
        port: 0,
        writeDaemonFile: false,
        webDistDir: null,
        storeBackend: backend,
        boardSyncPeriodicMs: 10 * 60_000,
      });
      useTestAuth(handle);
      baseUrl = `http://127.0.0.1:${handle.port}`;
      const created = await json(
        await fetch(`${baseUrl}/api/tasks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'Carries a file', kind: 'task' }),
        })
      );
      taskId = created.meta.id;
    });

    afterEach(async () => {
      await handle.stop();
      if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
      else process.env.DISPATCH_HOME = originalDispatchHome;
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    });

    it('uploads, lists, downloads and deletes', async () => {
      const uploaded = await fetch(
        `${baseUrl}/api/tasks/${taskId}/attachments`,
        {
          method: 'POST',
          body: formWith(
            new File(['png-bytes'], 'spec.png', { type: 'image/png' })
          ),
        }
      );
      expect(uploaded.status).toBe(200);
      const doc = await json(uploaded);
      expect(doc.meta.attachments).toEqual([
        {
          name: 'spec.png',
          path: `.dispatch/attachments/${taskId}/spec.png`,
          size: 9,
          addedAt: expect.any(String),
        },
      ]);
      const blob = join(root, '.dispatch', 'attachments', taskId, 'spec.png');
      expect(readFileSync(blob, 'utf8')).toBe('png-bytes');
      expect(
        readFileSync(join(root, '.dispatch', '.gitignore'), 'utf8')
      ).toContain('attachments/');

      // The list rides on the task record of whichever backend is live.
      if (backend === 'files') {
        const file = new TaskStore(root).taskFilePath(taskId)!;
        expect(readFileSync(file, 'utf8')).toContain('attachments:');
      } else {
        const db = new Database(dispatchDbPath(root), { readonly: true });
        try {
          const row = db
            .prepare('SELECT attachments FROM tasks WHERE id = ?')
            .get(taskId) as { attachments: string };
          expect(JSON.parse(row.attachments)[0].name).toBe('spec.png');
        } finally {
          db.close();
        }
      }

      const listed = await json(
        await fetch(`${baseUrl}/api/tasks/${taskId}/attachments`)
      );
      expect(listed.attachments.map((a: { name: string }) => a.name)).toEqual([
        'spec.png',
      ]);

      const download = await fetch(
        `${baseUrl}/api/tasks/${taskId}/attachments/spec.png`
      );
      expect(download.status).toBe(200);
      expect(download.headers.get('content-type')).toContain('image/png');
      expect(download.headers.get('content-disposition')).toBe(
        `inline; filename="spec.png"; filename*=UTF-8''spec.png`
      );
      expect(await download.text()).toBe('png-bytes');

      // HEAD is the presence check the desktop makes before opening the path
      // locally: the same status, no body.
      const probe = await fetch(
        `${baseUrl}/api/tasks/${taskId}/attachments/spec.png`,
        { method: 'HEAD' }
      );
      expect(probe.status).toBe(200);
      expect(await probe.text()).toBe('');
      expect(
        (
          await fetch(`${baseUrl}/api/tasks/${taskId}/attachments/other.png`, {
            method: 'HEAD',
          })
        ).status
      ).toBe(404);

      const removed = await fetch(
        `${baseUrl}/api/tasks/${taskId}/attachments/spec.png`,
        { method: 'DELETE' }
      );
      expect(removed.status).toBe(200);
      expect('attachments' in (await json(removed)).meta).toBe(false);
      expect(existsSync(blob)).toBe(false);
      expect(
        (await fetch(`${baseUrl}/api/tasks/${taskId}/attachments/spec.png`))
          .status
      ).toBe(404);
    });

    it('de-duplicates a repeated name and keeps the earlier file', async () => {
      const post = (text: string) =>
        fetch(`${baseUrl}/api/tasks/${taskId}/attachments`, {
          method: 'POST',
          body: formWith(new File([text], 'notes.txt')),
        });
      await post('first');
      const doc = await json(await post('second'));
      expect(doc.meta.attachments.map((a: { name: string }) => a.name)).toEqual(
        ['notes.txt', 'notes (2).txt']
      );
      const dir = join(root, '.dispatch', 'attachments', taskId);
      expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('first');
      expect(readFileSync(join(dir, 'notes (2).txt'), 'utf8')).toBe('second');
    });

    // A header value must be Latin-1, so the name rides in `filename*` and
    // the quoted fallback keeps only its ASCII.
    it('serves a name outside Latin-1 with an RFC 5987 disposition', async () => {
      const name = 'Дом 📎.png';
      const uploaded = await fetch(
        `${baseUrl}/api/tasks/${taskId}/attachments`,
        {
          method: 'POST',
          body: formWith(new File(['cyrillic'], name, { type: 'image/png' })),
        }
      );
      expect(uploaded.status).toBe(200);
      expect((await json(uploaded)).meta.attachments[0].name).toBe(name);

      const download = await fetch(
        `${baseUrl}/api/tasks/${taskId}/attachments/${encodeURIComponent(name)}`
      );
      expect(download.status).toBe(200);
      expect(download.headers.get('content-disposition')).toBe(
        `inline; filename="attachment.png"; filename*=UTF-8''${encodeURIComponent(name)}`
      );
      expect(await download.text()).toBe('cyrillic');

      const removed = await fetch(
        `${baseUrl}/api/tasks/${taskId}/attachments/${encodeURIComponent(name)}`,
        { method: 'DELETE' }
      );
      expect(removed.status).toBe(200);
    });

    // `.dispatch/attachments/<id>/` sits on a case-insensitive filesystem on
    // macOS and Windows, so a name that differs only by case is a repeat.
    it('de-duplicates a name that differs only by case', async () => {
      const post = (name: string) =>
        fetch(`${baseUrl}/api/tasks/${taskId}/attachments`, {
          method: 'POST',
          body: formWith(new File([name], name)),
        });
      await post('spec.png');
      const doc = await json(await post('Spec.png'));
      expect(doc.meta.attachments.map((a: { name: string }) => a.name)).toEqual(
        ['spec.png', 'Spec (2).png']
      );
      const dir = join(root, '.dispatch', 'attachments', taskId);
      expect(readFileSync(join(dir, 'spec.png'), 'utf8')).toBe('spec.png');
      expect(readFileSync(join(dir, 'Spec (2).png'), 'utf8')).toBe('Spec.png');
    });

    it('rejects a client-supplied attachments list on PATCH', async () => {
      const res = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ attachments: [] }),
      });
      expect(res.status).toBe(400);
      expect((await json(res)).error).toContain('attachments');
    });
  });
}

describe('attachment route guards', () => {
  let root: string;
  let fakeHome: string;
  let handle: ServerHandle;
  let baseUrl: string;
  let taskId: string;
  const originalDispatchHome = process.env.DISPATCH_HOME;

  beforeEach(async () => {
    fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
    process.env.DISPATCH_HOME = fakeHome;
    root = initGitRepo('dispatch-attachments-');
    TaskStore.init(root);
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      webDistDir: null,
      storeBackend: 'files',
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;
    taskId = (
      await json(
        await fetch(`${baseUrl}/api/tasks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'Guarded', kind: 'task' }),
        })
      )
    ).meta.id;
  });

  afterEach(async () => {
    await handle.stop();
    if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
    else process.env.DISPATCH_HOME = originalDispatchHome;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('answers 413 over the per-file cap', async () => {
    const oversized = new File(
      [new Uint8Array(ATTACHMENT_MAX_BYTES + 1)],
      'huge.bin'
    );
    const byFile = await fetch(`${baseUrl}/api/tasks/${taskId}/attachments`, {
      method: 'POST',
      body: formWith(oversized),
    });
    expect(byFile.status).toBe(413);
    expect((await json(byFile)).error).toBe('huge.bin exceeds the 25 MB limit');
    expect(existsSync(join(root, '.dispatch', 'attachments', taskId))).toBe(
      false
    );
  });

  // The cap is per file, not per request: a batch whose total crosses it
  // lands as long as each file is under.
  it('accepts a batch whose sum exceeds the cap when each file is under it', async () => {
    const half = new Uint8Array(ATTACHMENT_MAX_BYTES / 2 + 1);
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/attachments`, {
      method: 'POST',
      body: formWith(new File([half], 'a.bin'), new File([half], 'b.bin')),
    });
    expect(res.status).toBe(200);
    expect(
      (await json(res)).meta.attachments.map((a: { name: string }) => a.name)
    ).toEqual(['a.bin', 'b.bin']);
  });

  it('answers 400 on a name with nothing safe left of it, and keeps a traversal inside the task dir', async () => {
    const dotdot = await fetch(`${baseUrl}/api/tasks/${taskId}/attachments`, {
      method: 'POST',
      body: formWith(new File(['x'], '..')),
    });
    expect(dotdot.status).toBe(400);
    expect((await json(dotdot)).error).toContain('invalid attachment name');

    const traversal = await fetch(
      `${baseUrl}/api/tasks/${taskId}/attachments`,
      {
        method: 'POST',
        body: formWith(new File(['x'], '../../escaped.txt')),
      }
    );
    expect(traversal.status).toBe(200);
    expect((await json(traversal)).meta.attachments[0].name).toBe(
      'escaped.txt'
    );
    expect(existsSync(join(root, '.dispatch', 'escaped.txt'))).toBe(false);
    expect(
      existsSync(join(root, '.dispatch', 'attachments', taskId, 'escaped.txt'))
    ).toBe(true);

    // An encoded traversal on the download side reduces to a name that is
    // not on the list.
    const sneaky = await fetch(
      `${baseUrl}/api/tasks/${taskId}/attachments/${encodeURIComponent('../../config.yml')}`
    );
    expect(sneaky.status).toBe(404);
  });

  it('answers 400 when the form carries no files', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/attachments`, {
      method: 'POST',
      body: new FormData(),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('no files were uploaded');
  });

  it('answers 404 for an unknown task on every route', async () => {
    const base = `${baseUrl}/api/tasks/t-000000/attachments`;
    expect(
      (
        await fetch(base, {
          method: 'POST',
          body: formWith(new File(['x'], 'a.txt')),
        })
      ).status
    ).toBe(404);
    expect((await fetch(base)).status).toBe(404);
    expect((await fetch(`${base}/a.txt`)).status).toBe(404);
    expect((await fetch(`${base}/a.txt`, { method: 'DELETE' })).status).toBe(
      404
    );
  });

  it('never answers 415 for multipart — the bearer and origin checks cover it', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/attachments`, {
      method: 'POST',
      body: formWith(new File(['x'], 'a.txt')),
    });
    expect(res.status).not.toBe(415);
    expect(res.status).toBe(200);
  });

  it('answers 401 without a bearer', async () => {
    const res = await rawFetch(`${baseUrl}/api/tasks/${taskId}/attachments`, {
      method: 'POST',
      body: formWith(new File(['x'], 'a.txt')),
    });
    expect(res.status).toBe(401);
  });
});
