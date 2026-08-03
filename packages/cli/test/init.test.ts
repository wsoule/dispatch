import { beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

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

// A fake `carto` binary in its own PATH-prepended directory, so discoverCarto
// finds it without depending on whether real carto happens to be installed
// on the machine running this. `succeeds` controls whether its `init`
// subcommand leaves behind the `.carto/carto.db` cartoInit() checks for.
function stubCartoBinDir(succeeds: boolean): string {
  const binDir = mkdtempSync(join(tmpdir(), 'dispatch-cli-carto-bin-'));
  const initBody = succeeds
    ? 'mkdir -p .carto && echo x > .carto/carto.db && exit 0'
    : 'exit 1';
  writeFileSync(
    join(binDir, 'carto'),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "carto-md 2.1.3"\nelif [ "$1" = "init" ]; then\n  ${initBody}\nelse\n  exit 1\nfi\n`
  );
  chmodSync(join(binDir, 'carto'), 0o755);
  return binDir;
}

// Runs `fn` with PATH temporarily overridden, restoring it afterward even if
// `fn` throws or rejects.
async function withPath<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const original = process.env.PATH;
  process.env.PATH = value;
  try {
    return await fn();
  } finally {
    process.env.PATH = original;
  }
}

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

  it('surfaces a CliError instead of crashing on a valid-JSON-but-non-object .mcp.json (null)', async () => {
    writeFileSync(join(root, '.mcp.json'), 'null');
    await expect(
      makeProgram(ctx).parseAsync(['init'], { from: 'user' })
    ).rejects.toThrow(/invalid \.mcp\.json: not a JSON object/);
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe('null');
  });

  it('surfaces a CliError instead of corrupting a valid-JSON-but-non-object .mcp.json (array)', async () => {
    writeFileSync(join(root, '.mcp.json'), '[1,2,3]');
    await expect(
      makeProgram(ctx).parseAsync(['init'], { from: 'user' })
    ).rejects.toThrow(/invalid \.mcp\.json: not a JSON object/);
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe('[1,2,3]');
  });

  it('--no-mcp skips .mcp.json registration entirely', async () => {
    await makeProgram(ctx).parseAsync(['init', '--no-mcp'], { from: 'user' });
    expect(existsSync(join(root, '.mcp.json'))).toBe(false);
    expect(lines.join('\n')).not.toContain(
      'Registered the dispatch MCP server'
    );
  });
});

describe('dispatch init — carto container build', () => {
  it('builds the container when a usable carto binary is on PATH', async () => {
    const binDir = stubCartoBinDir(true);
    await withPath(`${binDir}${delimiter}${process.env.PATH ?? ''}`, () =>
      makeProgram(ctx).parseAsync(['init'], { from: 'user' })
    );
    expect(existsSync(join(root, '.carto/carto.db'))).toBe(true);
    expect(lines.join('\n')).toContain('Indexed the repo with carto 2.1.3');
  });

  it('adds .carto/ to .gitignore when the container is built', async () => {
    const binDir = stubCartoBinDir(true);
    await withPath(`${binDir}${delimiter}${process.env.PATH ?? ''}`, () =>
      makeProgram(ctx).parseAsync(['init'], { from: 'user' })
    );
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.carto/');
  });

  it('does not duplicate an existing .carto ignore entry', async () => {
    writeFileSync(join(root, '.gitignore'), 'node_modules\n.carto/\n');
    await makeProgram(ctx).parseAsync(['init'], { from: 'user' });
    const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
    expect(gitignore.match(/\.carto\//g)).toHaveLength(1);
  });

  it('starts .carto/ on its own line when .gitignore lacks a trailing newline', async () => {
    writeFileSync(join(root, '.gitignore'), 'node_modules');
    await makeProgram(ctx).parseAsync(['init'], { from: 'user' });
    const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
    expect(gitignore).toBe('node_modules\n.carto/\n');
  });

  // Regardless of whether the real machine running this has carto installed,
  // pointing PATH at nothing reproduces "carto not available" — the case
  // this integration exists to degrade from, not depend on ambient state.
  it('degrades quietly when carto is not on PATH', async () => {
    await withPath('/nonexistent', () =>
      makeProgram(ctx).parseAsync(['init'], { from: 'user' })
    );
    expect(existsSync(join(root, '.carto'))).toBe(false);
    expect(lines.join('\n')).toContain('Initialized');
    expect(lines.join('\n')).not.toContain('Indexed the repo');
  });

  it('reports skipped rather than throwing when carto init fails', async () => {
    const binDir = stubCartoBinDir(false);
    await withPath(`${binDir}${delimiter}${process.env.PATH ?? ''}`, () =>
      makeProgram(ctx).parseAsync(['init'], { from: 'user' })
    );
    expect(existsSync(join(root, '.carto/carto.db'))).toBe(false);
    expect(lines.join('\n')).toContain('carto index skipped');
  });

  it('does not attempt to build the container when carto.enabled is off', async () => {
    // No PATH override on this first call: it only needs to scaffold
    // .dispatch, and running it with carto absent keeps the setup step from
    // depending on (or being slowed by) whatever carto happens to be on
    // this machine.
    await withPath('/nonexistent', () =>
      makeProgram(ctx).parseAsync(['init'], { from: 'user' })
    );
    writeFileSync(
      join(root, '.dispatch/config.yml'),
      `${readFileSync(join(root, '.dispatch/config.yml'), 'utf8')}carto:\n  enabled: off\n`
    );
    const binDir = stubCartoBinDir(true);
    lines = [];
    await withPath(`${binDir}${delimiter}${process.env.PATH ?? ''}`, () =>
      makeProgram(ctx).parseAsync(['init'], { from: 'user' })
    );
    expect(existsSync(join(root, '.carto'))).toBe(false);
    expect(lines.join('\n')).not.toContain('Indexed the repo');
    expect(lines.join('\n')).not.toContain('carto index skipped');
  });
});
