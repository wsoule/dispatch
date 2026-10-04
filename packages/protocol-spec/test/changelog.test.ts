import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import { loadVectors } from '../src/load.js';

const TYPES = new Set(['editorial', 'clarification', 'additive', 'breaking']);
// A retired id stays citable, so the entry that retires it still names it.
const { vectors, retired } = loadVectors();
const ids = new Set([...vectors, ...retired].map((v) => v.id));
const changelog = readFileSync(
  new URL('../CHANGELOG.md', import.meta.url),
  'utf8'
);

// Every entry is typed, and every non-editorial one names vectors that exist
// (§14.2: no normative change lands without a vector).
it('types every entry and names existing vectors for normative ones', () => {
  // A list item may wrap; join its continuation lines before checking it.
  const entries = changelog
    .split('\n- ')
    .slice(1)
    .map((item) => `- ${(item.split('\n\n')[0] ?? '').replace(/\n\s+/g, ' ')}`);
  for (const entry of entries) {
    const type = /^- \[([a-z]+)\]/.exec(entry)?.[1] ?? '';
    expect({ entry, typed: TYPES.has(type) }).toEqual({ entry, typed: true });
    if (type === 'editorial') continue;
    const cited = [...entry.matchAll(/`([a-z0-9]+(?:\.[a-z0-9-]+){2})`/g)].map(
      (m) => m[1] ?? ''
    );
    expect({
      entry,
      cited: cited.length > 0 && cited.every((id) => ids.has(id)),
    }).toEqual({ entry, cited: true });
  }
});
