import { resolve } from 'node:path';

import type {
  Executor,
  ExecutorEvents,
  ExecutorRun,
  ExecutorStartOptions,
} from '../../src/orchestrator/types.js';

const MCP_BIN = resolve(import.meta.dir, '../../../mcp/dist/bin.js');

// One MCP tools/call through the real dispatch-mcp bin, as a run's agent makes it.
export async function mcpCall(
  rootDir: string,
  env: Record<string, string>,
  name: string,
  args: Record<string, unknown>
): Promise<{ structuredContent?: Record<string, unknown>; isError?: boolean }> {
  const proc = Bun.spawn(['node', MCP_BIN, '--root', rootDir], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
    env: { ...process.env, ...env },
  });
  const write = (msg: object) => {
    void proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  };
  try {
    write({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2026-11-25',
        capabilities: {},
        clientInfo: { name: 'outbound-test', version: '0' },
      },
    });
    write({ method: 'notifications/initialized' });
    write({ id: 2, method: 'tools/call', params: { name, arguments: args } });
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('dispatch-mcp exited before answering');
      buf += decoder.decode(value);
      for (let i = buf.indexOf('\n'); i !== -1; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const msg = JSON.parse(line) as { id?: number; result?: unknown };
        if (msg.id === 2)
          return msg.result as {
            structuredContent?: Record<string, unknown>;
          };
      }
    }
  } finally {
    proc.kill();
  }
}

// A parked run that keeps what reaches its session and the token file the
// daemon wrote for its MCP tools.
export class SessionExecutor implements Executor {
  readonly received: string[] = [];
  tokenFile: string | null = null;
  start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun {
    this.tokenFile = opts.runTokenFile ?? null;
    events.onSession?.('session-recording');
    return {
      interrupt: () => Promise.resolve(),
      requestStop: () => {},
      send: (text) => {
        this.received.push(text);
      },
      notify: (text) => {
        this.received.push(text);
      },
      approve: () => {},
    };
  }
}
