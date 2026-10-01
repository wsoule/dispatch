import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
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
import { listSections, sectionsOf, SPEC_DIR } from '../src/sections.js';

const registry = loadRegistry();
const sections = new Set(listSections(SPEC_DIR));
const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const script = fileURLToPath(
  new URL('../scripts/registries.ts', import.meta.url)
);

// Whether a reference is `spec/<file>#s<n>` for a section that file declares.
function resolves(reference: string | undefined): boolean {
  const m = /^spec\/([^#/]+\.md)#s(.+)$/.exec(reference ?? '');
  if (m === null) return false;
  const file = new URL(m[1] ?? '', SPEC_DIR);
  return (
    existsSync(file) &&
    sectionsOf(readFileSync(file, 'utf8')).includes(m[2] ?? '')
  );
}

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

  it('requires who raises a gate type, its choices, data and effect', () => {
    const gate = {
      ...kind,
      value: 'wake',
      section: '5.9',
      raisedBy: 'system',
      choices: ['approve', 'deny'],
      data: { target: 'address' },
      effect: 'wake the target',
    };
    const gates = (g: object) => ({ ...emptyRegistry(), 'gate-types': [g] });
    expect(loadRegistry(fileOf(gates(gate)))['gate-types']).toHaveLength(1);
    for (const field of ['raisedBy', 'choices', 'data', 'effect']) {
      expect(() =>
        loadRegistry(fileOf(gates({ ...gate, [field]: undefined })))
      ).toThrow(`registries.json: gate-types[0] ${field} must`);
    }
  });
});

describe('renderRegistries', () => {
  it('links each entry to the section that defines it', () => {
    expect(renderRegistries(registry, '1.0.0-draft.1')).toContain(
      '[§5.9](05-gates.md#s5.9)'
    );
  });

  // The live registry may have no provisional entry left, so add one.
  it('lists provisional entries apart only in a stable version', () => {
    const apart = 'Not part of this version (provisional):';
    const withProvisional = structuredClone(registry);
    withProvisional['address-schemes'].push({
      value: 'x-peer',
      scope: 'a2a',
      status: 'provisional',
      since: '1.0.0-draft.1',
      section: '8.9',
      reference: 'spec/08-a2a-binding.md#s8.9',
      vectors: [],
    });
    expect(renderRegistries(withProvisional, '1.0.0-draft.1')).not.toContain(
      apart
    );
    expect(renderRegistries(withProvisional, '1.0.0')).toContain(apart);
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

  it('gives every non-core entry a reference to its defining section', () => {
    for (const name of REGISTRY_NAMES) {
      for (const e of registry[name].filter((r) => r.scope !== 'core'))
        expect({ name, value: e.value, ok: resolves(e.reference) }).toEqual({
          name,
          value: e.value,
          ok: true,
        });
    }
  });

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
