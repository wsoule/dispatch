import { afterEach, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadVectors } from '../src/load.js';

const TYPES = new Set(['editorial', 'clarification', 'additive', 'breaking']);
const changelog = readFileSync(
  new URL('../CHANGELOG.md', import.meta.url),
  'utf8'
);

// The ids an entry may cite: a kit's vectors, and its retired ones, so the
// entry that retires a vector still names it.
function citable(dir?: URL): Set<string> {
  const { vectors, retired } = loadVectors(dir);
  return new Set([...vectors, ...retired].map((v) => v.id));
}

// Each entry of a changelog with whether it is typed and, unless editorial,
// whether it cites at least one vector and only ids in `ids`.
function judged(
  text: string,
  ids: Set<string>
): { entry: string; typed: boolean; cited: boolean }[] {
  // A list item may wrap; join its continuation lines before checking it.
  const entries = `\n${text}`
    .split('\n- ')
    .slice(1)
    .map((item) => `- ${(item.split('\n\n')[0] ?? '').replace(/\n\s+/g, ' ')}`);
  return entries.map((entry) => {
    const type = /^- \[([a-z]+)\]/.exec(entry)?.[1] ?? '';
    const cited = [...entry.matchAll(/`([a-z0-9]+(?:\.[a-z0-9-]+){2})`/g)].map(
      (m) => m[1] ?? ''
    );
    return {
      entry,
      typed: TYPES.has(type),
      cited:
        type === 'editorial' ||
        (cited.length > 0 && cited.every((id) => ids.has(id))),
    };
  });
}

let scratch: string | null = null;
afterEach(() => {
  if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

// Every entry is typed, and every non-editorial one names vectors that exist
// (§14.2: no normative change lands without a vector).
it('types every entry and names existing vectors for normative ones', () => {
  const ids = citable();
  for (const row of judged(changelog, ids))
    expect(row).toEqual({ entry: row.entry, typed: true, cited: true });
});

it('lets an entry cite a vector the kit has retired', () => {
  scratch = mkdtempSync(join(tmpdir(), 'dmp-retired-'));
  const entry = '- [breaking] Drops a rule. Vectors: `core.send.an-old-rule`.';
  const bare = pathToFileURL(`${scratch}/`);
  writeFileSync(join(scratch, 'retired.json'), '{ "retired": [] }');
  expect(judged(entry, citable(bare))[0]?.cited).toBe(false);
  writeFileSync(
    join(scratch, 'retired.json'),
    JSON.stringify({
      retired: [
        { id: 'core.send.an-old-rule', reason: 'the rule was dropped' },
      ],
    })
  );
  expect(judged(entry, citable(bare))[0]?.cited).toBe(true);
});
