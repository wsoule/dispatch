import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ENGINE_REGISTRIES,
  loadRegistry,
  REGISTRY_NAMES,
  renderRegistries,
} from '../src/registries.js';
import { listSections, SPEC_DIR } from '../src/sections.js';

const registry = loadRegistry();
const sections = new Set(listSections(SPEC_DIR));
const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const script = fileURLToPath(
  new URL('../scripts/registries.ts', import.meta.url)
);

describe('loadRegistry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dmp-registries-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const kind = {
    value: 'notice',
    scope: 'core',
    status: 'provisional',
    since: '1.0.0-draft.1',
    section: '4.2',
    vectors: [],
  };

  function emptyRegistry(): Record<string, unknown> {
    return Object.fromEntries(REGISTRY_NAMES.map((n) => [n, []]));
  }

  function fileOf(json: Record<string, unknown>): URL {
    const file = join(dir, `${crypto.randomUUID()}.json`);
    writeFileSync(file, JSON.stringify(json));
    return pathToFileURL(file);
  }

  it('names the registry and index of a bad entry', () => {
    const json = {
      ...emptyRegistry(),
      kinds: [kind, { ...kind, status: 'stable' }],
    };
    expect(() => loadRegistry(fileOf(json))).toThrow(
      'registries.json: kinds[1] status'
    );
  });

  it('refuses a missing registry', () => {
    const json = emptyRegistry();
    delete json['extension-uris'];
    expect(() => loadRegistry(fileOf(json))).toThrow(
      'registries.json: extension-uris is missing'
    );
  });

  it('refuses a field its registry does not define', () => {
    const json = {
      ...emptyRegistry(),
      kinds: [{ ...kind, raisedBy: 'system' }],
    };
    expect(() => loadRegistry(fileOf(json))).toThrow(
      'registries.json: kinds[0] has unknown field raisedBy'
    );
  });
});

describe('renderRegistries', () => {
  it('links each entry to the section that defines it', () => {
    expect(renderRegistries(registry, '1.0.0-draft.1')).toContain(
      '[§5.9](05-gates.md#s5.9)'
    );
  });

  it('lists provisional entries apart only in a stable version', () => {
    const apart = 'Not part of this version (provisional):';
    expect(renderRegistries(registry, '1.0.0-draft.1')).not.toContain(apart);
    expect(renderRegistries(registry, '1.0.0')).toContain(apart);
  });
});

describe('registries.json', () => {
  it('has every registry', () => {
    expect(Object.keys(registry).sort()).toEqual([...REGISTRY_NAMES].sort());
  });

  for (const name of REGISTRY_NAMES) {
    it(`${name}: values are unique and sections exist`, () => {
      const values = registry[name].map((e) => e.value);
      expect(new Set(values).size).toBe(values.length);
      for (const e of registry[name])
        expect({ value: e.value, section: sections.has(e.section) }).toEqual({
          value: e.value,
          section: true,
        });
    });
  }

  it('gives every permanent entry a vector and no provisional entry any', () => {
    for (const name of REGISTRY_NAMES) {
      for (const e of registry[name]) {
        if (e.status === 'permanent')
          expect({ name, value: e.value, n: e.vectors.length > 0 }).toEqual({
            name,
            value: e.value,
            n: true,
          });
        if (e.status === 'provisional')
          expect({ name, value: e.value, vectors: e.vectors }).toEqual({
            name,
            value: e.value,
            vectors: [],
          });
      }
    }
  });

  it('describes every gate type', () => {
    for (const g of registry['gate-types']) {
      expect(
        g.raisedBy === undefined ||
          g.choices === undefined ||
          g.effect === undefined
      ).toBe(false);
    }
  });

  it('names the engine-level registries', () => {
    expect([...ENGINE_REGISTRIES].sort()).toEqual([
      'address-schemes',
      'delivery-states',
      'error-codes',
      'gate-types',
      'kinds',
      'ref-types',
      'system-markers',
    ]);
  });

  it('regenerating §11 changes nothing and writes no file into spec/', () => {
    const specDir = fileURLToPath(SPEC_DIR);
    const mode = statSync(specDir).mode;
    chmodSync(specDir, 0o555);
    try {
      const run = spawnSync('bun', [script, '--check'], {
        cwd: pkgDir,
        encoding: 'utf8',
      });
      expect({ code: run.status, err: run.stderr }).toEqual({
        code: 0,
        err: '',
      });
    } finally {
      chmodSync(specDir, mode);
    }
  });
});
