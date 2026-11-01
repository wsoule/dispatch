import { TaskStore } from '@dispatch-foo/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDispatchMcpServer } from '../src/index.js';

// task_save and task_list on a board linked to Linear: its names are not the
// built-ins, and its review status is its dispatched one.

const LINEAR_CONFIG = `statuses:
  - { name: Backlog, type: backlog }
  - { name: Todo, type: unstarted }
  - { name: In Progress, type: started }
  - { name: Done, type: completed }
  - { name: Canceled, type: canceled }
statusRoles:
  ready: Todo
  dispatched: In Progress
  review: In Progress
  landing: null
  landed: Done
  dropped: Canceled
`;

interface ToolCallResult {
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  content: { type: string; text?: string }[];
}

let fakeHome: string;
let root: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-mcp-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-mcp-status-'));
  TaskStore.init(root);
  writeFileSync(join(root, '.dispatch', 'config.yml'), LINEAR_CONFIG);
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

async function call(
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolCallResult> {
  const s = createDispatchMcpServer(root);
  const client = new Client({ name: 'test-client', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), s.connect(b)]);
  return (await client.callTool({ name, arguments: args })) as ToolCallResult;
}

function text(result: ToolCallResult): string {
  return result.content.map((c) => c.text ?? '').join('');
}

async function saved(args: Record<string, unknown>): Promise<string> {
  const result = await call('task_save', args);
  expect(result.isError).toBeUndefined();
  return (result.structuredContent!.meta as { status: string }).status;
}

describe('status input on a Linear board', () => {
  it('maps built-in words through the board roles', async () => {
    expect(await saved({ title: 'a', status: 'landed' })).toBe('Done');
    expect(await saved({ title: 'b', status: 'draft' })).toBe('Backlog');
    expect(await saved({ title: 'c', status: 'working' })).toBe('In Progress');
    expect(await saved({ title: 'd', status: 'dropped' })).toBe('Canceled');
  });

  it('matches the board names case-insensitively before any alias', async () => {
    expect(await saved({ title: 'a', status: 'done' })).toBe('Done');
    expect(await saved({ title: 'b', status: 'in progress' })).toBe(
      'In Progress'
    );
    expect(await saved({ title: 'c', status: 'todo' })).toBe('Todo');
  });

  it('starts a local create in the ready role', async () => {
    expect(await saved({ title: 'a' })).toBe('Todo');
  });

  it('resolves an update the same way', async () => {
    const created = await call('task_save', { title: 'a' });
    const id = (created.structuredContent!.meta as { id: string }).id;
    expect(await saved({ id, status: 'review' })).toBe('In Progress');
  });

  it('refuses a word with no status, naming what was sent', async () => {
    const shipped = await call('task_save', { title: 'a', status: 'shipped' });
    expect(shipped.isError).toBe(true);
    expect(text(shipped)).toBe(
      'invalid status: shipped (expected Backlog|Todo|In Progress|Done|Canceled)'
    );
    // The board leaves the landing role unset, so the word has nowhere to go.
    const landing = await call('task_save', { title: 'a', status: 'landing' });
    expect(landing.isError).toBe(true);
    expect(text(landing)).toContain('invalid status: landing');
  });

  it('filters task_list by a resolved status', async () => {
    await saved({ title: 'a', status: 'Done' });
    await saved({ title: 'b' });
    const result = await call('task_list', { status: 'landed' });
    const tasks = result.structuredContent!.tasks as { title: string }[];
    expect(tasks.map((t) => t.title)).toEqual(['a']);
  });
});
