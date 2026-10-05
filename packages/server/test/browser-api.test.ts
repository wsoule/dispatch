import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findChrome } from '../src/browser/session.js';
import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { json } from './json.js';
import { runGitSync } from './orchestrator/helpers.js';
import { rawFetch, useTestAuth } from './testAuth.js';

const FIXTURE_HTML = `<!doctype html>
<html><body style="margin:0">
  <h1 id="title" style="color: rgb(0, 128, 0)">Browser API</h1>
  <button id="go" onclick="document.getElementById('out').textContent='clicked'">Go</button>
  <input id="field" />
  <p id="out">idle</p>
</body></html>`;

let fakeHome: string;
let root: string;
let fixture: string;
let handle: ServerHandle;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;
const chrome = process.env.CHROME_PATH ?? findChrome();

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-browser-api-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial']);
  return dir;
}

function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has('content-type'))
    headers.set('content-type', 'application/json');
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initRepo();
  fixture = join(root, 'fixture.html');
  writeFileSync(fixture, FIXTURE_HTML);
  TaskStore.init(root);
  handle = await startServer({ rootDir: root, port: 0 });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('browser routes without a browser open', () => {
  it('lists nothing at first', async () => {
    expect(await json(await apiFetch('/api/browser'))).toEqual([]);
  });

  it('404s an unknown session', async () => {
    expect((await apiFetch('/api/browser/nope')).status).toBe(404);
    expect((await apiFetch('/api/browser/nope/screenshot')).status).toBe(404);
    expect(
      (
        await apiFetch('/api/browser/nope/click', {
          method: 'POST',
          body: JSON.stringify({ selector: 'a' }),
        })
      ).status
    ).toBe(404);
  });

  // The security property: a browser holds the user's own session cookies and
  // `evaluate` runs arbitrary script in it, so the agent token must not reach
  // any of this.
  it('refuses the agent token across the whole family', async () => {
    for (const [path, init] of [
      ['/api/browser', undefined],
      ['/api/browser', { method: 'POST', body: '{}' }],
    ] as const) {
      const res = await rawFetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${handle.tokens.agentToken}`,
          'content-type': 'application/json',
        },
      });
      expect(res.status).toBe(403);
    }
  });
});

const describeWithChrome = chrome === null ? describe.skip : describe;

describeWithChrome('browser routes driving a real Chromium', () => {
  async function launch(): Promise<string> {
    const res = await apiFetch('/api/browser', {
      method: 'POST',
      body: JSON.stringify({ url: `file://${fixture}`, headless: true }),
    });
    expect(res.status).toBe(201);
    return (await json(res)).id as string;
  }

  async function close(id: string): Promise<void> {
    await apiFetch(`/api/browser/${id}`, { method: 'DELETE' });
  }

  it('launches, lists and closes a session', async () => {
    const id = await launch();
    const listed = await json(await apiFetch('/api/browser'));
    expect(listed.map((b: { id: string }) => b.id)).toEqual([id]);

    expect(
      (await apiFetch(`/api/browser/${id}`, { method: 'DELETE' })).status
    ).toBe(200);
    expect(await json(await apiFetch('/api/browser'))).toEqual([]);
  }, 60_000);

  it('reads text, clicks and fills', async () => {
    const id = await launch();
    try {
      const title = await json(
        await apiFetch(`/api/browser/${id}/text?selector=%23title`)
      );
      expect(title.text).toContain('Browser API');

      await apiFetch(`/api/browser/${id}/click`, {
        method: 'POST',
        body: JSON.stringify({ selector: '#go' }),
      });
      const out = await json(
        await apiFetch(`/api/browser/${id}/text?selector=%23out`)
      );
      expect(out.text).toBe('clicked');

      await apiFetch(`/api/browser/${id}/fill`, {
        method: 'POST',
        body: JSON.stringify({ selector: '#field', value: 'typed' }),
      });
      const value = await json(
        await apiFetch(`/api/browser/${id}/evaluate`, {
          method: 'POST',
          body: JSON.stringify({
            expression: 'document.getElementById("field").value',
          }),
        })
      );
      expect(value.value).toBe('typed');
    } finally {
      await close(id);
    }
  }, 60_000);

  it('400s a selector that matches nothing rather than 500ing', async () => {
    const id = await launch();
    try {
      const res = await apiFetch(`/api/browser/${id}/click`, {
        method: 'POST',
        body: JSON.stringify({ selector: '#missing' }),
      });
      // A bad selector is a bad request against the page's current state.
      expect(res.status).toBe(400);
      expect((await json(res)).error).toContain('no element matches');
    } finally {
      await close(id);
    }
  }, 60_000);

  it('takes a screenshot', async () => {
    const id = await launch();
    try {
      const body = await json(await apiFetch(`/api/browser/${id}/screenshot`));
      expect(body.screenshot.startsWith('iVBORw0KGgo')).toBe(true);
    } finally {
      await close(id);
    }
  }, 60_000);

  it('runs the Design Mode pick end to end', async () => {
    const id = await launch();
    try {
      expect(
        (
          await json(
            await apiFetch(`/api/browser/${id}/pick`, { method: 'POST' })
          )
        ).picking
      ).toBe(true);
      expect((await json(await apiFetch(`/api/browser/${id}`))).picking).toBe(
        true
      );
      expect(
        (await json(await apiFetch(`/api/browser/${id}/pick`))).state
      ).toBe('waiting');

      // Standing in for the user's click on the element.
      await apiFetch(`/api/browser/${id}/evaluate`, {
        method: 'POST',
        body: JSON.stringify({
          expression:
            'document.getElementById("title").dispatchEvent(new MouseEvent("click", { bubbles: true }))',
        }),
      });

      const picked = await json(await apiFetch(`/api/browser/${id}/pick`));
      expect(picked.state).toBe('picked');
      expect(picked.element.selector).toBe('#title');
      expect(picked.element.outerHTML).toContain('Browser API');
      expect(picked.element.styles.color).toBe('rgb(0, 128, 0)');
      expect(picked.screenshot.startsWith('iVBORw0KGgo')).toBe(true);

      // The session stops reporting itself as picking once it has a result.
      expect((await json(await apiFetch(`/api/browser/${id}`))).picking).toBe(
        false
      );
    } finally {
      await close(id);
    }
  }, 60_000);

  it('navigates and reports the new url', async () => {
    const id = await launch();
    try {
      const after = await json(
        await apiFetch(`/api/browser/${id}/navigate`, {
          method: 'POST',
          body: JSON.stringify({ url: 'about:blank' }),
        })
      );
      expect(after.url).toBe('about:blank');
    } finally {
      await close(id);
    }
  }, 60_000);

  it('validates bodies', async () => {
    const id = await launch();
    try {
      expect(
        (
          await apiFetch(`/api/browser/${id}/click`, {
            method: 'POST',
            body: JSON.stringify({}),
          })
        ).status
      ).toBe(400);
      expect(
        (
          await apiFetch(`/api/browser/${id}/fill`, {
            method: 'POST',
            body: JSON.stringify({ selector: '#field', value: 42 }),
          })
        ).status
      ).toBe(400);
      expect((await apiFetch(`/api/browser/${id}/text`)).status).toBe(400);
    } finally {
      await close(id);
    }
  }, 60_000);

  it('kills every browser when the daemon stops', async () => {
    // Without this, each session leaks a Chromium that outlives the daemon.
    await launch();
    await handle.stop();
    // A second stop must not throw; the afterEach calls it again.
    await handle.stop();
  }, 60_000);
});
