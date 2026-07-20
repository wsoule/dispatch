import { TaskStore } from '@dispatch/core';
import { beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BIN = resolve(import.meta.dirname, '../dist/bin.js');
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-mcp-e2e-'));
  TaskStore.init(root);
});

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: unknown;
}

// Drives the *built* `dispatch-mcp` binary over its real stdio — newline-
// delimited JSON-RPC messages sent to a spawned child process — rather than
// the SDK's InMemoryTransport (see server.test.ts). This is what proves the
// shebang + Node entrypoint + StdioServerTransport wiring actually works,
// not just the tool logic in-process.
async function withStdioClient(
  fn: (
    send: (method: string, params?: unknown) => Promise<JsonRpcResponse>,
    notify: (method: string, params?: unknown) => void
  ) => Promise<void>
): Promise<void> {
  const proc = Bun.spawn(['node', BIN, '--root', root], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const pending = new Map<number, (msg: JsonRpcResponse) => void>();
  let nextId = 1;
  let buf = '';

  const pump = (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim() === '') continue;
        const msg = JSON.parse(line) as JsonRpcResponse;
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      }
    }
  })();

  function send(
    method: string,
    params: unknown = {}
  ): Promise<JsonRpcResponse> {
    const id = nextId++;
    void proc.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
    );
    return new Promise((res) => pending.set(id, res));
  }
  function notify(method: string, params: unknown = {}): void {
    void proc.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`
    );
  }

  try {
    await fn(send, notify);
  } finally {
    proc.kill();
    await pump.catch(() => {});
  }
}

describe('dispatch-mcp stdio e2e', () => {
  it('serves initialize, tools/list, and a tools/call over real stdio', async () => {
    await withStdioClient(async (send, notify) => {
      const init = await send('initialize', {
        protocolVersion: '2026-11-25',
        capabilities: {},
        clientInfo: { name: 'e2e', version: '0.0.1' },
      });
      expect(
        (init.result as { serverInfo: { name: string } }).serverInfo.name
      ).toBe('dispatch');
      notify('notifications/initialized');

      const list = await send('tools/list');
      const names = (list.result as { tools: { name: string }[] }).tools
        .map((t) => t.name)
        .sort();
      expect(names).toEqual([
        'run_list',
        'task_comment',
        'task_get',
        'task_list',
        'task_next',
        'task_save',
      ]);

      const call = await send('tools/call', {
        name: 'task_next',
        arguments: {},
      });
      const result = call.result as { structuredContent: { tasks: unknown[] } };
      expect(result.structuredContent.tasks).toEqual([]);
    });
  }, 15_000);
});

describe('dispatch-mcp --root argument errors', () => {
  it('exits 1 with a clear stderr message when --root has no value', () => {
    const proc = Bun.spawnSync({
      cmd: ['node', BIN, '--root'],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain(
      '--root requires a directory argument'
    );
  });

  it('exits 1 with a clear stderr message when --root is followed by another flag', () => {
    const proc = Bun.spawnSync({
      cmd: ['node', BIN, '--root', '--verbose'],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain(
      '--root requires a directory argument'
    );
  });
});
