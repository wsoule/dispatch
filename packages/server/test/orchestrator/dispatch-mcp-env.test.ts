import { describe, expect, it } from 'bun:test';

import { dispatchMcpSpec } from '../../src/orchestrator/dispatchMcp.js';

describe('dispatchMcpSpec', () => {
  it('passes the run token alongside the run id', () => {
    const spec = dispatchMcpSpec(
      '/tmp/wt',
      '/tmp/root',
      'r-000001',
      'r-000001.abc'
    );
    expect(spec.env.DISPATCH_RUN_ID).toBe('r-000001');
    expect(spec.env.DISPATCH_RUN_TOKEN).toBe('r-000001.abc');
  });
  it('omits the token when none is given', () => {
    expect(
      dispatchMcpSpec('/tmp/wt', '/tmp/root', 'r-000001').env.DISPATCH_RUN_TOKEN
    ).toBeUndefined();
  });
});
