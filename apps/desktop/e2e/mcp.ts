import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { REPO } from './paths';

// The docs specs drive the MCP server over stdio, as an agent's client does.

interface RpcReply {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

// A minimal newline-delimited JSON-RPC client over the MCP server's stdio.
export class StdioMcp {
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

/** An initialized MCP server for `name` in `root`, as a registered external
 *  agent (no run token): its client still needs the owner's approval. */
export async function startAgentMcp(
  root: string,
  home: string,
  name: string
): Promise<StdioMcp> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DISPATCH_HOME: home,
    DISPATCH_AGENT_NAME: name,
  };
  delete env.DISPATCH_RUN_TOKEN_FILE;
  delete env.DISPATCH_RUN_ID;
  const mcp = new StdioMcp(
    spawn('bun', [join(REPO, 'packages/mcp/src/bin.ts')], { cwd: root, env })
  );
  await mcp.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name, version: '1' },
  });
  mcp.notify('notifications/initialized');
  return mcp;
}
