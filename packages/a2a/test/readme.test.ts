import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The README carries security rules a later edit must not drop.
const README = readFileSync(join(import.meta.dir, '..', 'README.md'), 'utf8');

describe('README: reaching your agent', () => {
  it('names the operator-tier rule for tailnet peers', () => {
    expect(README).toMatch(/tailnet\s+peer[^.]*operator\s+tier/i);
  });

  it('warns that an edge terminating TLS can read bearer traffic', () => {
    expect(README).toMatch(/can\s+read\s+bearer\s+traffic/i);
  });

  it('tells Dispatch peers behind an edge to pair, so requests are signed', () => {
    expect(README).toMatch(/pair[^.]*sign/i);
  });

  it('says trustForwardedFor is safe only when the proxy appends X-Forwarded-For', () => {
    expect(README).toMatch(/trustForwardedFor[^.]*only\s+when[^.]*appends/i);
  });

  it('says a standalone host cannot carry a bearer-to-signature upgrade yet', () => {
    expect(README).toMatch(
      /upgrading[^.]*standalone\s+host[^.]*not\s+supported/i
    );
  });
});
