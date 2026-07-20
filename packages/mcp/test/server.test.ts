import { TaskStore } from '@dispatch/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDispatchMcpServer } from '../src/index.js';
import { ONBOARDING_MARKDOWN } from '../src/onboarding.js';

let root: string;
let server: McpServer;
let client: Client;

// Connects a fresh in-process Client to a fresh server rooted at `root`, the
// canonical test pattern from the SDK's own test suite
// (InMemoryTransport.createLinkedPair + Promise.all connect).
async function connect(
  rootDir: string
): Promise<{ client: Client; server: McpServer }> {
  const s = createDispatchMcpServer(rootDir);
  const c = new Client({ name: 'test-client', version: '1.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([c.connect(clientTransport), s.connect(serverTransport)]);
  return { client: c, server: s };
}

// Shape returned by callTool(): { content, structuredContent?, isError? }.
interface ToolCallResult {
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  content: { type: string; text?: string }[];
}

function callToolText(result: ToolCallResult): string {
  return result.content.map((c) => c.text ?? '').join('');
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-mcp-'));
  ({ client, server } = await connect(root));
});

describe('server identity', () => {
  it('reports the dispatch server name', () => {
    expect(server.server.constructor.name).toBe('Server');
  });

  it('lists all five task tools plus run_list', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'run_list',
      'task_comment',
      'task_get',
      'task_list',
      'task_next',
      'task_save',
    ]);
  });

  it('does not claim task_save is idempotent (create makes a new task every call)', async () => {
    const { tools } = await client.listTools();
    const taskSave = tools.find((t) => t.name === 'task_save');
    expect(taskSave?.annotations?.idempotentHint).not.toBe(true);
  });
});

describe('not initialized', () => {
  it('every tool returns a clean not-initialized error', async () => {
    const result = (await client.callTool({
      name: 'task_list',
      arguments: {},
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(callToolText(result)).toBe('not initialized — run: dispatch init');
  });
});

describe('task_save', () => {
  beforeEach(() => {
    TaskStore.init(root);
  });

  it('creates a task when id is omitted', async () => {
    const result = (await client.callTool({
      name: 'task_save',
      arguments: { title: 'Build parser', priority: 'high' },
    })) as ToolCallResult;
    expect(result.isError).toBeUndefined();
    const meta = result.structuredContent?.meta as {
      id: string;
      title: string;
      priority: string;
    };
    expect(meta.title).toBe('Build parser');
    expect(meta.priority).toBe('high');
    expect(meta.id).toMatch(/^t-[0-9a-f]{6}$/);
  });

  it('rejects an empty title on create', async () => {
    const result = (await client.callTool({
      name: 'task_save',
      arguments: { title: '  ' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(callToolText(result)).toBe('title must not be empty');
  });

  it('rejects an invalid priority with the CLI-style message', async () => {
    const result = (await client.callTool({
      name: 'task_save',
      arguments: { title: 'x', priority: 'urgentish' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(callToolText(result)).toBe(
      'invalid priority: urgentish (expected urgent|high|medium|low|none)'
    );
  });

  it('rejects an invalid status against config.statuses', async () => {
    const result = (await client.callTool({
      name: 'task_save',
      arguments: { title: 'x', status: 'nope' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(callToolText(result)).toBe(
      'invalid status: nope (expected backlog|todo|in-progress|in-review|done|cancelled)'
    );
  });

  it('updates only the provided fields, leaving others untouched', async () => {
    const created = (await client.callTool({
      name: 'task_save',
      arguments: { title: 'Original', priority: 'low' },
    })) as ToolCallResult;
    const id = (created.structuredContent!.meta as { id: string }).id;

    const updated = (await client.callTool({
      name: 'task_save',
      arguments: { id, status: 'in-progress' },
    })) as ToolCallResult;
    const meta = updated.structuredContent?.meta as {
      status: string;
      priority: string;
      title: string;
    };
    expect(meta.status).toBe('in-progress');
    expect(meta.priority).toBe('low');
    expect(meta.title).toBe('Original');
  });

  it('ignores kind and description on update (core UpdatePatch contract)', async () => {
    const created = (await client.callTool({
      name: 'task_save',
      arguments: { title: 'Original', kind: 'task', description: 'first' },
    })) as ToolCallResult;
    const id = (created.structuredContent!.meta as { id: string }).id;

    const updated = (await client.callTool({
      name: 'task_save',
      arguments: { id, kind: 'epic', description: 'second' },
    })) as ToolCallResult;
    const meta = updated.structuredContent?.meta as { kind: string };
    const body = updated.structuredContent?.body as string;
    expect(meta.kind).toBe('task');
    expect(body).toContain('first');
    expect(body).not.toContain('second');
  });

  it('reports task not found on update with an unknown id', async () => {
    const result = (await client.callTool({
      name: 'task_save',
      arguments: { id: 't-ffffff', status: 'done' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(callToolText(result)).toBe('task not found: t-ffffff');
  });

  it('does not write when the effective update patch is empty (kind/description only)', async () => {
    const store = new TaskStore(root);
    const created = store.create({ title: 'Untouched', description: 'first' });
    const filePath = store.taskFilePath(created.meta.id)!;
    const mtimeBefore = statSync(filePath).mtimeMs;

    const result = (await client.callTool({
      name: 'task_save',
      arguments: { id: created.meta.id, kind: 'epic', description: 'second' },
    })) as ToolCallResult;
    expect(result.isError).toBeUndefined();
    const meta = result.structuredContent?.meta as {
      updated: string;
      kind: string;
    };
    expect(meta.updated).toBe(created.meta.updated);
    expect(meta.kind).toBe('task');
    expect(result.structuredContent?.body).toBe(created.body);
    expect(statSync(filePath).mtimeMs).toBe(mtimeBefore);
  });
});

describe('task_get', () => {
  beforeEach(() => {
    TaskStore.init(root);
  });

  it('returns full meta and body for a known id', async () => {
    const store = new TaskStore(root);
    const doc = store.create({ title: 'Read me', description: 'hello' });

    const result = (await client.callTool({
      name: 'task_get',
      arguments: { id: doc.meta.id },
    })) as ToolCallResult;
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent!.meta as { id: string }).id).toBe(
      doc.meta.id
    );
    expect(result.structuredContent?.body as string).toContain('hello');
  });

  it('returns a clean error for an unknown id', async () => {
    const result = (await client.callTool({
      name: 'task_get',
      arguments: { id: 't-abcdef' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(callToolText(result)).toBe('task not found: t-abcdef');
  });

  it('returns a clean doctor-pointing error for a corrupt task file', async () => {
    const store = new TaskStore(root);
    writeFileSync(
      join(store.tasksDir, 't-c0ffee-corrupt.md'),
      'no frontmatter here'
    );

    const result = (await client.callTool({
      name: 'task_get',
      arguments: { id: 't-c0ffee' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(callToolText(result)).toContain('missing frontmatter');
    expect(callToolText(result)).toContain("run 'dispatch doctor'");
  });
});

describe('task_list', () => {
  beforeEach(() => {
    TaskStore.init(root);
  });

  it('returns TaskSummary shape without body or external', async () => {
    const store = new TaskStore(root);
    store.create({ title: 'A', kind: 'task' });
    store.create({ title: 'B', kind: 'epic' });

    const result = (await client.callTool({
      name: 'task_list',
      arguments: {},
    })) as ToolCallResult;
    const tasks = result.structuredContent?.tasks as Record<string, unknown>[];
    expect(tasks.length).toBe(2);
    for (const t of tasks) {
      expect(t.body).toBeUndefined();
      expect(t.external).toBeUndefined();
      expect(t.id).toBeDefined();
    }
  });

  it('filters by kind', async () => {
    const store = new TaskStore(root);
    store.create({ title: 'A', kind: 'task' });
    store.create({ title: 'B', kind: 'epic' });

    const result = (await client.callTool({
      name: 'task_list',
      arguments: { kind: 'epic' },
    })) as ToolCallResult;
    const tasks = result.structuredContent?.tasks as { title: string }[];
    expect(tasks.map((t) => t.title)).toEqual(['B']);
  });

  it('rejects an invalid kind filter', async () => {
    const result = (await client.callTool({
      name: 'task_list',
      arguments: { kind: 'story' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(callToolText(result)).toBe(
      'invalid kind: story (expected task|epic)'
    );
  });

  it('reports an empty problems array when every file parses cleanly', async () => {
    const store = new TaskStore(root);
    store.create({ title: 'A' });

    const result = (await client.callTool({
      name: 'task_list',
      arguments: {},
    })) as ToolCallResult;
    expect(result.structuredContent?.problems).toEqual([]);
  });

  it('surfaces an unparsable file as a problem instead of failing the whole call', async () => {
    const store = new TaskStore(root);
    const good = store.create({ title: 'Good task' });
    writeFileSync(join(store.tasksDir, 'corrupt.md'), 'no frontmatter here');

    const result = (await client.callTool({
      name: 'task_list',
      arguments: {},
    })) as ToolCallResult;
    expect(result.isError).toBeUndefined();
    const tasks = result.structuredContent?.tasks as { id: string }[];
    expect(tasks.map((t) => t.id)).toEqual([good.meta.id]);
    const problems = result.structuredContent?.problems as string[];
    expect(problems).toEqual([
      "corrupt.md: missing frontmatter — run 'dispatch doctor'",
    ]);
  });
});

describe('task_comment', () => {
  beforeEach(() => {
    TaskStore.init(root);
  });

  it('appends a timestamped activity line', async () => {
    const store = new TaskStore(root);
    const doc = store.create({ title: 'Track me' });

    const result = (await client.callTool({
      name: 'task_comment',
      arguments: { id: doc.meta.id, text: 'made progress' },
    })) as ToolCallResult;
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent!.meta as { id: string }).id).toBe(
      doc.meta.id
    );

    const onDisk = store.get(doc.meta.id);
    expect(onDisk?.body).toMatch(/- \d{4}-\d{2}-\d{2}T.*made progress/);
  });

  it('reports task not found for an unknown id', async () => {
    const result = (await client.callTool({
      name: 'task_comment',
      arguments: { id: 't-abcdef', text: 'x' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(callToolText(result)).toBe('task not found: t-abcdef');
  });
});

describe('task_next', () => {
  beforeEach(() => {
    TaskStore.init(root);
  });

  it('returns only unblocked ready tasks, priority-ordered', async () => {
    const store = new TaskStore(root);
    const blocker = store.create({ title: 'Blocker', priority: 'low' });
    const blocked = store.create({
      title: 'Blocked',
      priority: 'urgent',
      blockedBy: [blocker.meta.id],
    });
    const readyNow = store.create({ title: 'Ready now', priority: 'medium' });

    let result = (await client.callTool({
      name: 'task_next',
      arguments: {},
    })) as ToolCallResult;
    let tasks = result.structuredContent?.tasks as { id: string }[];
    // medium (readyNow) sorts before low (blocker); `blocked` isn't ready yet.
    expect(tasks.map((t) => t.id)).toEqual([readyNow.meta.id, blocker.meta.id]);

    store.update(blocker.meta.id, { status: 'done' });
    result = (await client.callTool({
      name: 'task_next',
      arguments: {},
    })) as ToolCallResult;
    tasks = result.structuredContent?.tasks as { id: string }[];
    expect(tasks.map((t) => t.id)).toEqual([blocked.meta.id, readyNow.meta.id]);
  });

  it('surfaces an unparsable file as a problem instead of failing the whole call', async () => {
    const store = new TaskStore(root);
    const ready = store.create({ title: 'Ready' });
    writeFileSync(join(store.tasksDir, 'corrupt.md'), 'no frontmatter here');

    const result = (await client.callTool({
      name: 'task_next',
      arguments: {},
    })) as ToolCallResult;
    expect(result.isError).toBeUndefined();
    const tasks = result.structuredContent?.tasks as { id: string }[];
    expect(tasks.map((t) => t.id)).toEqual([ready.meta.id]);
    const problems = result.structuredContent?.problems as string[];
    expect(problems).toEqual([
      "corrupt.md: missing frontmatter — run 'dispatch doctor'",
    ]);
  });
});

describe('onboarding resource', () => {
  it('is readable and matches the onboarding markdown', async () => {
    const { contents } = await client.readResource({
      uri: 'workflow://onboarding',
    });
    expect(contents.length).toBe(1);
    const content = contents[0] as { mimeType?: string; text?: string };
    expect(content.mimeType).toBe('text/markdown');
    expect(content.text).toBe(ONBOARDING_MARKDOWN);
  });
});
