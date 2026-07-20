import { beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CliContext } from '../src/context.js';
import { makeProgram } from '../src/program.js';

let root: string;
let lines: string[];
let ctx: CliContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-'));
  lines = [];
  ctx = { cwd: root, log: (l) => lines.push(l) };
});

describe('dispatch init', () => {
  it('scaffolds .dispatch and reports success', async () => {
    await makeProgram(ctx).parseAsync(['init'], { from: 'user' });
    expect(existsSync(join(root, '.dispatch/tasks'))).toBe(true);
    expect(existsSync(join(root, '.dispatch/config.yml'))).toBe(true);
    expect(lines.join('\n')).toContain('Initialized');
  });
  it('is idempotent', async () => {
    await makeProgram(ctx).parseAsync(['init'], { from: 'user' });
    await makeProgram(ctx).parseAsync(['init'], { from: 'user' });
    expect(lines.join('\n')).toContain('already initialized');
  });
});

describe('dispatch init — .mcp.json registration', () => {
  it('creates .mcp.json registering the dispatch server', async () => {
    await makeProgram(ctx).parseAsync(['init'], { from: 'user' });
    const mcpJson = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    expect(mcpJson.mcpServers.dispatch).toEqual({
      command: 'dispatch',
      args: ['mcp'],
    });
    expect(lines.join('\n')).toContain('Registered the dispatch MCP server');
  });

  it('merges alongside an existing .mcp.json without clobbering other servers', async () => {
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'other-server' } } })
    );
    await makeProgram(ctx).parseAsync(['init'], { from: 'user' });
    const mcpJson = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    expect(mcpJson.mcpServers.other).toEqual({ command: 'other-server' });
    expect(mcpJson.mcpServers.dispatch).toEqual({
      command: 'dispatch',
      args: ['mcp'],
    });
  });

  it('is idempotent across repeated init runs', async () => {
    await makeProgram(ctx).parseAsync(['init'], { from: 'user' });
    const first = readFileSync(join(root, '.mcp.json'), 'utf8');
    await makeProgram(ctx).parseAsync(['init'], { from: 'user' });
    const second = readFileSync(join(root, '.mcp.json'), 'utf8');
    expect(second).toBe(first);
  });

  it('surfaces a CliError instead of clobbering a malformed .mcp.json', async () => {
    writeFileSync(join(root, '.mcp.json'), '{ not json');
    await expect(
      makeProgram(ctx).parseAsync(['init'], { from: 'user' })
    ).rejects.toThrow(/invalid \.mcp\.json/);
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe('{ not json');
  });

  it('--no-mcp skips .mcp.json registration entirely', async () => {
    await makeProgram(ctx).parseAsync(['init', '--no-mcp'], { from: 'user' });
    expect(existsSync(join(root, '.mcp.json'))).toBe(false);
    expect(lines.join('\n')).not.toContain(
      'Registered the dispatch MCP server'
    );
  });
});
