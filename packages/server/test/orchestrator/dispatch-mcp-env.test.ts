import { describe, expect, it } from 'bun:test';

import { dispatchMcpSpec } from '../../src/orchestrator/dispatchMcp.js';

describe('dispatchMcpSpec', () => {
  it('points the MCP at the run token file, never at the token itself', () => {
    const spec = dispatchMcpSpec(
      '/tmp/wt',
      '/tmp/root',
      'r-000001',
      '/tmp/runs/r-000001.token'
    );
    expect(spec.env.DISPATCH_RUN_ID).toBe('r-000001');
    expect(spec.env.DISPATCH_RUN_TOKEN_FILE).toBe('/tmp/runs/r-000001.token');
    expect(spec.env.DISPATCH_RUN_TOKEN).toBeUndefined();
  });
  it('omits the token file when none is given', () => {
    const spec = dispatchMcpSpec('/tmp/wt', '/tmp/root', 'r-000001');
    expect(spec.env.DISPATCH_RUN_TOKEN_FILE).toBeUndefined();
    expect(spec.env.DISPATCH_RUN_TOKEN).toBeUndefined();
  });
});
