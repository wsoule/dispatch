import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';

import { FormatError, parseVectorFile } from '../src/format.js';
import { loadVectors, VECTORS_DIR } from '../src/load.js';
import { stripThen } from '../src/prepare.js';
import { KIT_VERSION } from '../src/version.js';

const SCHEMAS_DIR = new URL('../schemas/', import.meta.url);
const files = readdirSync(SCHEMAS_DIR).filter((f) =>
  f.endsWith('.schema.json')
);
const ajv = new Ajv2020({ strict: true, allErrors: true });
// Every schema is added first, so one may `$ref` another by its `$id`.
for (const f of files)
  ajv.addSchema(
    JSON.parse(readFileSync(new URL(f, SCHEMAS_DIR), 'utf8')) as object
  );
const idOf = (file: string): string =>
  `https://dispatch.foo/protocol/${KIT_VERSION}/schemas/${file}`;
const schema = (name: string) => {
  const validate = ajv.getSchema(idOf(`${name}.schema.json`));
  if (validate === undefined) throw new Error(`no schema ${name}`);
  return validate;
};
const { vectors } = loadVectors();

// Schemas are informative (§1.4) but must not contradict the vectors.
describe('schemas agree with the vectors', () => {
  it('names the kit version in every live $id, and compiles in strict mode', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const raw = JSON.parse(readFileSync(new URL(f, SCHEMAS_DIR), 'utf8')) as {
        $id?: unknown;
      };
      expect({ f, $id: raw.$id }).toEqual({ f, $id: idOf(f) });
      expect(typeof schema(f.replace('.schema.json', ''))).toBe('function');
    }
  });

  it('every envelope input a vector accepts validates', () => {
    const sendInput = schema('send-input');
    for (const v of vectors.filter((x) => x.class === 'envelope')) {
      v.when.forEach((step, i) => {
        if (step.op !== 'validate' || v.then.steps?.[i]?.ok !== true) return;
        expect({ id: v.id, step: i, valid: sendInput(step['input']) }).toEqual({
          id: v.id,
          step: i,
          valid: true,
        });
      });
    }
  });

  it('every input a vector rejects for a structural reason fails', () => {
    const sendInput = schema('send-input');
    const structural = vectors.filter((x) =>
      (x.tags ?? []).includes('structural')
    );
    expect(structural.length).toBeGreaterThan(0);
    for (const v of structural) {
      v.when.forEach((step, i) => {
        if (step.op !== 'validate' || v.then.steps?.[i]?.ok !== false) return;
        expect({ id: v.id, step: i, valid: sendInput(step['input']) }).toEqual({
          id: v.id,
          step: i,
          valid: false,
        });
      });
    }
  });

  it('every gate data an accepted send carries validates', () => {
    const gateData = schema('gate-data');
    const raw = JSON.parse(
      readFileSync(new URL('gate-data.schema.json', SCHEMAS_DIR), 'utf8')
    ) as { $defs: Record<string, unknown> };
    const gateTypes = new Set(Object.keys(raw.$defs));
    let checked = 0;
    for (const v of vectors) {
      v.when.forEach((step, i) => {
        if (step.op !== 'send' && step.op !== 'validate') return;
        if (v.then.steps?.[i]?.ok !== true) return;
        const data = (step['input'] as { data?: { type?: unknown } }).data;
        if (typeof data?.type !== 'string' || !gateTypes.has(data.type)) return;
        checked += 1;
        expect({
          id: v.id,
          step: i,
          valid: gateData(data),
          errors: gateData.errors ?? null,
        }).toEqual({ id: v.id, step: i, valid: true, errors: null });
      });
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('describes every vector file', () => {
    const vectorFile = schema('vector');
    const classes = readdirSync(VECTORS_DIR).filter(
      (d) => !d.endsWith('.json')
    );
    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      for (const f of readdirSync(new URL(`${cls}/`, VECTORS_DIR))) {
        const file = JSON.parse(
          readFileSync(new URL(`${cls}/${f}`, VECTORS_DIR), 'utf8')
        ) as unknown;
        expect({
          file: f,
          valid: vectorFile(file),
          errors: vectorFile.errors ?? null,
        }).toEqual({ file: f, valid: true, errors: null });
      }
    }
  });

  // A schema that accepted anything would pass the tests above, so each of
  // these slips must fail both the schema and the runner's own check.
  it('refuses the vector files the runner refuses', () => {
    const vectorFile = schema('vector');
    const base = JSON.parse(
      readFileSync(new URL('host-core/send.json', VECTORS_DIR), 'utf8')
    ) as { vectors: Record<string, unknown>[] };
    const slips: Record<string, (v: Record<string, unknown>) => void> = {
      'an unknown member': (v) => {
        v['note'] = 'x';
      },
      'a MAY vector without a capability': (v) => {
        v['level'] = 'MAY';
      },
      'an id prefix of another class': (v) => {
        v['id'] = 'env.send.misfiled';
      },
      'a send step without its input': (v) => {
        v['when'] = [
          { op: 'send', as: { address: 'human:wyat', canDecide: true } },
        ];
      },
      'an unknown expectation': (v) => {
        v['then'] = { sometimes: true };
      },
    };
    for (const [slip, apply] of Object.entries(slips)) {
      const file = structuredClone(base);
      const first = file.vectors[0];
      if (first === undefined) throw new Error('send.json has no vectors');
      apply(first);
      let refused = false;
      try {
        parseVectorFile(file, 'host-core/send.json');
      } catch (err) {
        refused = err instanceof FormatError;
      }
      expect({ slip, runner: refused, schema: vectorFile(file) }).toEqual({
        slip,
        runner: true,
        schema: false,
      });
    }
  });

  it('describes the run message the runner sends for every vector', () => {
    const adapter = schema('adapter');
    for (const v of vectors) {
      const run = { dmp: 'run', vector: stripThen(v) };
      expect({
        id: v.id,
        valid: adapter(run),
        errors: adapter.errors ?? null,
      }).toEqual({ id: v.id, valid: true, errors: null });
    }
  });
});
