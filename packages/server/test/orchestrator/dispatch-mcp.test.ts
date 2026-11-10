import { afterEach, describe, expect, it } from 'bun:test';

import {
  cartoSpecFor,
  DISPATCH_MCP_TOOL_TIMEOUT_MS,
  dispatchMcpSpec,
} from '../../src/orchestrator/dispatchMcp.js';

const originalMcpBin = process.env.DISPATCH_MCP_BIN;
const originalSecret = process.env.DISPATCH_MCP_TEST_SECRET;

afterEach(() => {
  if (originalMcpBin === undefined) delete process.env.DISPATCH_MCP_BIN;
  else process.env.DISPATCH_MCP_BIN = originalMcpBin;
  if (originalSecret === undefined) delete process.env.DISPATCH_MCP_TEST_SECRET;
  else process.env.DISPATCH_MCP_TEST_SECRET = originalSecret;
});

describe('dispatchMcpSpec', () => {
  it('runs the TS entry under bun, rooted at the worktree, with the run identity in env', () => {
    delete process.env.DISPATCH_MCP_BIN;
    process.env.DISPATCH_MCP_TEST_SECRET = 'must-not-leak';
    const spec = dispatchMcpSpec('/wt', '/proj', 'r-1');
    expect(spec.command).toBe('bun');
    expect(spec.args.slice(-2)).toEqual(['--root', '/wt']);
    expect(spec.args[0]).toMatch(/bin\.ts$/);
    expect(spec.env.DISPATCH_PROJECT_ROOT).toBe('/proj');
    expect(spec.env.DISPATCH_RUN_ID).toBe('r-1');
    expect(spec.timeoutMs).toBe(DISPATCH_MCP_TOOL_TIMEOUT_MS);
    expect(DISPATCH_MCP_TOOL_TIMEOUT_MS).toBe(24 * 60 * 60_000 + 60_000);
    // The env is an allowlist: an arbitrary inherited variable never crosses.
    expect(spec.env.DISPATCH_MCP_TEST_SECRET).toBeUndefined();
    for (const key of Object.keys(spec.env)) {
      expect([
        'PATH',
        'HOME',
        'TMPDIR',
        'LANG',
        'LC_ALL',
        'BUN_INSTALL',
        'DISPATCH_HOME',
        'DISPATCH_PROJECT_ROOT',
        'DISPATCH_RUN_ID',
      ]).toContain(key);
    }
  });

  it('runs the packaged binary directly when DISPATCH_MCP_BIN is set', () => {
    process.env.DISPATCH_MCP_BIN = '/opt/dispatch-mcp';
    const spec = dispatchMcpSpec('/wt', '/proj', 'r-2');
    expect(spec.command).toBe('/opt/dispatch-mcp');
    expect(spec.args).toEqual(['--root', '/wt']);
  });
});

describe('cartoSpecFor', () => {
  it('passes the project root and binary as positional shell parameters', () => {
    const spec = cartoSpecFor('/proj$(touch /tmp/x)', {
      path: '/opt/carto',
      version: '2.1.4',
    });
    expect(spec.command).toBe('/bin/sh');
    expect(spec.args[1]).not.toContain('$(');
    expect(spec.args).toContain('/proj$(touch /tmp/x)');
    expect(spec.args).toContain('/opt/carto');
    expect(spec.env.CARTO_MCP_TIER).toBeUndefined();
    expect(spec.timeoutMs).toBeUndefined();
  });
});
