import { describe, expect, it } from 'bun:test';

import { loadVectors } from '../src/load.js';
import { loadRegistry, REGISTRY_NAMES } from '../src/registries.js';
import { listSections, SPEC_DIR } from '../src/sections.js';

const { vectors } = loadVectors();
const ids = new Set(vectors.map((v) => v.id));
const sections = new Set(listSections(SPEC_DIR));

describe('the kit', () => {
  it('names only sections that exist', () => {
    for (const v of vectors)
      for (const s of v.sections)
        expect({ id: v.id, s, ok: sections.has(s) }).toEqual({
          id: v.id,
          s,
          ok: true,
        });
  });

  it('lists only vectors that exist in every registry entry', () => {
    const registry = loadRegistry();
    for (const name of REGISTRY_NAMES)
      for (const e of registry[name])
        for (const id of e.vectors)
          expect({ entry: e.value, id, ok: ids.has(id) }).toEqual({
            entry: e.value,
            id,
            ok: true,
          });
  });
});
