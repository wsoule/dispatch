import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';

import { type IsolatedDaemon, startIsolatedDaemon } from './isolatedDaemon';
import { APP_TOKEN, REPO } from './paths';

// The docs v0 flow: an agent writes a spec over the MCP tools and reads it back, the human
// links it and edits it in Docs, and an ops save landing during the human's autosave merges.

// Docs refuse the shared agent token, so the daemon is driven with the app token.
const APP = { authorization: `Bearer ${APP_TOKEN}` };
const AGENT_NAME = 'docs-e2e';
const SLUG = 'e2e-spec';

interface RpcReply {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

// A minimal newline-delimited JSON-RPC client over the MCP server's stdio.
class StdioMcp {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiting = new Map<number, (reply: RpcReply) => void>();
  private buffer = '';
  private nextId = 1;
  private stderr = '';

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString('utf8');
    });
    child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let nl = this.buffer.indexOf('\n');
      while (nl !== -1) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        const reply = JSON.parse(line) as RpcReply;
        if (reply.id !== undefined) this.waiting.get(reply.id)?.(reply);
        nl = this.buffer.indexOf('\n');
      }
    });
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const answered = new Promise<RpcReply>((resolve) => {
      this.waiting.set(id, resolve);
    });
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
    );
    const reply = await answered;
    this.waiting.delete(id);
    if (reply.error !== undefined) {
      throw new Error(
        `${method}: ${reply.error.message ?? 'failed'}\n${this.stderr}`
      );
    }
    return reply.result;
  }

  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  // A tool call's text, an error result's included, since the flow reads refusals too.
  async tool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.request('tools/call', {
      name,
      arguments: args,
    })) as { content: { text: string }[] };
    return result.content.map((c) => c.text).join('\n');
  }

  close(): void {
    this.child.kill();
  }
}

// This spec's own daemon on a copy of the fixture, so the doc, task and agent
// it creates never reach the shared fixture views.spec.ts screenshots.
let daemon: IsolatedDaemon | null = null;

function requireDaemon(): IsolatedDaemon {
  if (daemon === null) throw new Error('the isolated daemon is not running');
  return daemon;
}

async function api<T>(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  data?: unknown
): Promise<T> {
  const res = await request.fetch(`${requireDaemon().origin}/api${path}`, {
    method,
    headers: APP,
    data,
  });
  expect(
    res.ok(),
    `${method} ${path}: ${res.status()} ${await res.text()}`
  ).toBe(true);
  return (res.status() === 204 ? null : await res.json()) as T;
}

let mcp: StdioMcp | null = null;

// The copy goes with its daemon, so the doc, task and agent need no undoing.
test.afterEach(async () => {
  mcp?.close();
  mcp = null;
  await daemon?.stop();
  daemon = null;
});

test('an agent writes a spec, the human edits it in Docs, and a concurrent ops save merges', async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'dark', 'theme-independent flow');
  test.setTimeout(90_000);
  daemon = await startIsolatedDaemon('docs');
  const taskId = (
    await api<{ meta: { id: string } }>(request, 'POST', '/tasks', {
      title: 'Docs e2e task',
    })
  ).meta.id;

  // No run token file: the caller is a registered external agent, which adds context links only.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DISPATCH_HOME: daemon.home,
    DISPATCH_AGENT_NAME: AGENT_NAME,
  };
  delete env.DISPATCH_RUN_TOKEN_FILE;
  delete env.DISPATCH_RUN_ID;
  mcp = new StdioMcp(
    spawn('bun', [join(REPO, 'packages/mcp/src/bin.ts')], {
      cwd: daemon.root,
      env,
    })
  );
  const agent = mcp;
  await agent.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: AGENT_NAME, version: '1' },
  });
  agent.notify('notifications/initialized');
  expect(await agent.tool('doc_list', {})).toContain('awaiting approval');
  const { agents } = await api<{
    agents: { address: string; status: string }[];
  }>(request, 'GET', '/agents/roster');
  const pending = agents.find(
    (a) => a.address.endsWith(`/${AGENT_NAME}`) && a.status === 'pending'
  );
  if (pending === undefined) throw new Error(`${AGENT_NAME} never registered`);
  await api(
    request,
    'POST',
    `/agents/${encodeURIComponent(pending.address)}/approve`,
    {}
  );

  const created = await agent.tool('doc_save', {
    title: 'E2E spec',
    body: '# E2E spec\n## API\nagent v1\n## Risks\nnone yet\n',
  });
  expect(created).toContain(`saved doc ${SLUG} rev 1`);
  // Exit (a): the agent reads the spec through the tools, with nothing on disk.
  const readBack = await agent.tool('doc_read', { doc: SLUG, section: 'API' });
  expect(readBack).toContain('agent v1');
  expect(readBack).toMatch(/^~{8,} doc e2e-spec rev 1 ~{8,}$/m);

  // The spec link is the human's (decide tier on the app token); it also seals rev 1.
  const linked = await api<{
    links: { target: { type: string; id: string }; rel: string }[];
  }>(request, 'POST', `/docs/${SLUG}/links`, {
    target: `task:${taskId}`,
    rel: 'spec',
  });
  expect(linked.links).toContainEqual(
    expect.objectContaining({
      target: { type: 'task', id: taskId },
      rel: 'spec',
    })
  );

  // Holds the human's autosave until the agent's ops land, so the save is
  // based on rev 1 and the daemon must three-way merge it.
  let releaseSave: () => void = () => undefined;
  const saveHeld = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  let heldSaves = 0;
  await page.route('**/api/docs/*/body', async (route) => {
    heldSaves += 1;
    await saveHeld;
    await route.continue();
  });

  await page.goto(daemon.appUrl);
  await page.locator('#dispatch-sidebar [data-nav-item="docs"]').click();
  await page.getByRole('button', { name: 'E2E spec', exact: true }).click();
  const editor = page.getByLabel(`Editing ${SLUG}`);
  await expect(editor).toHaveValue(/agent v1/);
  await editor.focus();
  await editor.evaluate((el: HTMLTextAreaElement) => {
    el.setSelectionRange(el.value.length, el.value.length);
  });
  await page.keyboard.type('human risk\n');
  await expect.poll(() => heldSaves, { timeout: 5_000 }).toBeGreaterThan(0);

  // The agent edits another section while the human's save is in flight.
  const edited = await agent.tool('doc_save', {
    doc: SLUG,
    ops: [{ op: 'replace_section', section: 'API', text: 'agent v2' }],
  });
  expect(edited).toContain(`saved doc ${SLUG} rev 2`);
  releaseSave();

  await expect
    .poll(
      async () =>
        (await api<{ text: string }>(request, 'GET', `/docs/${SLUG}`)).text,
      { timeout: 10_000 }
    )
    .toBe('# E2E spec\n## API\nagent v2\n## Risks\nnone yet\nhuman risk\n');
  const read = await api<{ doc: { unreviewed: boolean } }>(
    request,
    'GET',
    `/docs/${SLUG}`
  );
  expect(read.doc.unreviewed).toBe(true);
  const history = await api<{
    revisions: { cause: string; parents: string[] }[];
  }>(request, 'GET', `/docs/${SLUG}/revisions`);
  expect(
    history.revisions.some((r) => r.cause === 'merge' && r.parents.length === 2)
  ).toBe(true);
  await expect(editor).toHaveValue(/agent v2[\s\S]*human risk/);
});
