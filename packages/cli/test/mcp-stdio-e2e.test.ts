import { beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BIN = resolve(import.meta.dirname, '../dist/cli.js');

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: unknown;
}

interface ToolCallResult {
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  content: { type: string; text?: string }[];
}

// Drives the *built* `dispatch mcp` CLI command over its real stdio —
// mirrors packages/mcp/test/e2e.test.ts's approach against the standalone
// `dispatch-mcp` bin, but through the CLI entrypoint (`node dist/cli.js
// mcp`), which is what `dispatch init`'s .mcp.json registration actually
// invokes for a real client. Proves the CLI's dynamic import + stdio
// hand-off works end to end, not just the in-process `program.ts` wiring.
async function withStdioClient(
  cwd: string,
  fn: (
    send: (method: string, params?: unknown) => Promise<JsonRpcResponse>,
    notify: (method: string, params?: unknown) => void
  ) => Promise<void>
): Promise<void> {
  const proc = Bun.spawn(['node', BIN, 'mcp'], {
    cwd,
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

async function handshake(
  send: (method: string, params?: unknown) => Promise<JsonRpcResponse>,
  notify: (method: string, params?: unknown) => void
): Promise<void> {
  const init = await send('initialize', {
    protocolVersion: '2026-11-25',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '0.0.1' },
  });
  expect(
    (init.result as { serverInfo: { name: string } }).serverInfo.name
  ).toBe('dispatch');
  notify('notifications/initialized');
}

describe('dispatch mcp (CLI entrypoint) stdio e2e', () => {
  let initializedRoot: string;

  beforeAll(() => {
    initializedRoot = mkdtempSync(join(tmpdir(), 'dispatch-cli-mcp-e2e-'));
    // Init directly through the built CLI, same as a real user would, so
    // this test doesn't depend on any in-process core API staying in sync
    // with what the binary actually does on disk.
    const init = Bun.spawnSync({
      cmd: ['node', BIN, 'init', '--no-mcp'],
      cwd: initializedRoot,
    });
    if (init.exitCode !== 0) {
      throw new Error(`dispatch init failed: ${init.stderr.toString()}`);
    }
  }, 20_000);

  it('serves tools/list and a tools/call over real stdio in an initialized repo', async () => {
    await withStdioClient(initializedRoot, async (send, notify) => {
      await handshake(send, notify);

      const list = await send('tools/list');
      const names = (list.result as { tools: { name: string }[] }).tools
        .map((t) => t.name)
        .sort();
      expect(names).toEqual([
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
      const result = call.result as ToolCallResult;
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent?.tasks).toEqual([]);
    });
  }, 15_000);

  it('returns a clean not-initialized tool error instead of failing to start', async () => {
    const uninitializedRoot = mkdtempSync(
      join(tmpdir(), 'dispatch-cli-mcp-e2e-uninit-')
    );
    await withStdioClient(uninitializedRoot, async (send, notify) => {
      await handshake(send, notify);

      const call = await send('tools/call', {
        name: 'task_list',
        arguments: {},
      });
      const result = call.result as ToolCallResult;
      expect(result.isError).toBe(true);
      expect(result.content.map((c) => c.text ?? '').join('')).toBe(
        'not initialized — run: dispatch init'
      );
    });
  }, 15_000);
});
