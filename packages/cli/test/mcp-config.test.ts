import { describe, expect, it } from 'bun:test';

import { CliError } from '../src/context.js';
import { mergeMcpConfig } from '../src/mcpConfig.js';

describe('mergeMcpConfig', () => {
  it('creates a fresh .mcp.json with the dispatch server when none exists', () => {
    const out = JSON.parse(mergeMcpConfig(undefined));
    expect(out).toEqual({
      mcpServers: { dispatch: { command: 'dispatch', args: ['mcp'] } },
    });
  });

  it('ends with a trailing newline', () => {
    expect(mergeMcpConfig(undefined).endsWith('\n')).toBe(true);
  });

  it('merges alongside an existing server, preserving it', () => {
    const existing = JSON.stringify({
      mcpServers: { other: { command: 'other-server' } },
    });
    const out = JSON.parse(mergeMcpConfig(existing));
    expect(out.mcpServers.other).toEqual({ command: 'other-server' });
    expect(out.mcpServers.dispatch).toEqual({
      command: 'dispatch',
      args: ['mcp'],
    });
  });

  it('preserves unrelated top-level keys', () => {
    const existing = JSON.stringify({ someOtherKey: 'keep-me' });
    const out = JSON.parse(mergeMcpConfig(existing));
    expect(out.someOtherKey).toBe('keep-me');
    expect(out.mcpServers.dispatch).toEqual({
      command: 'dispatch',
      args: ['mcp'],
    });
  });

  it('is idempotent — re-running on its own output changes nothing', () => {
    const first = mergeMcpConfig(undefined);
    const second = mergeMcpConfig(first);
    expect(second).toBe(first);
  });

  it('is idempotent alongside another server across repeated runs', () => {
    const existing = JSON.stringify({
      mcpServers: { other: { command: 'other-server' } },
    });
    const first = mergeMcpConfig(existing);
    const second = mergeMcpConfig(first);
    expect(second).toBe(first);
  });

  it('throws CliError on malformed existing JSON without clobbering it', () => {
    expect(() => mergeMcpConfig('{ not json')).toThrow(CliError);
    expect(() => mergeMcpConfig('{ not json')).toThrow(/invalid \.mcp\.json/);
  });

  it('throws CliError when mcpServers is present but not an object', () => {
    expect(() =>
      mergeMcpConfig(JSON.stringify({ mcpServers: 'nope' }))
    ).toThrow(CliError);
  });
});
