import { discoverCarto, openCartoReader } from '@dispatch/core/carto';
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import { normalizeBlastRadius } from '../src/depmap.js';

// Resolved from this file's location rather than process.cwd(), so the
// container check is correct however `bun test` is invoked (repo root or
// this package's own directory).
const repoRoot = join(import.meta.dirname, '..', '..', '..');

// This suite's gate must stay circumstantial. `bun test` from the repo root
// also preloads packages/cli's setup, which sets DISPATCH_CARTO_DISABLED for
// its own isolation; honoring it here would skip this by construction.
const env = { ...process.env };
delete env.DISPATCH_CARTO_DISABLED;
const discovery = discoverCarto(env);
// Gated on a *readable container*, not just the binary: the binary can be
// installed while its native bindings are broken, or this repo simply may
// not have run `dispatch init` yet. Either way there's nothing to open.
const opened = discovery.ok ? openCartoReader(repoRoot) : null;
const available = opened !== null && opened.ok;

if (!available) {
  if (!discovery.ok) {
    console.warn(
      `[carto-integration] SKIPPED — carto is not installed (${discovery.reason}: ${discovery.detail}). Install it with \`npm install -g carto-md\` under Node 22 LTS to run these.`
    );
  } else {
    const reason = opened !== null && !opened.ok ? opened.detail : 'unknown';
    console.warn(
      `[carto-integration] SKIPPED — carto is installed but this repo has no readable container (${reason}). Run \`dispatch init\` to build one.`
    );
  }
}

describe.if(available)('against a real carto container', () => {
  it('returns a blast radius whose shape matches what the code depends on', () => {
    // `describe.if(available)` guarantees this, but the type of `opened`
    // can't reflect that across the closure boundary.
    if (opened === null || !opened.ok) {
      throw new Error('unreachable: gated by describe.if(available)');
    }
    const raw = opened.reader.blastRadius('packages/core/src/types.ts');
    expect(typeof raw.count).toBe('number');
    expect(Array.isArray(raw.files)).toBe(true);
    expect(normalizeBlastRadius(raw).length).toBeGreaterThan(0);
  });
});
