import { afterEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseVectorFile } from '../src/format.js';
import { loadVectors } from '../src/load.js';

type RawFile = { vectors: Record<string, unknown>[] } & Record<string, unknown>;

const fixture = (p: string): RawFile =>
  JSON.parse(
    readFileSync(new URL(`fixtures/${p}`, import.meta.url), 'utf8')
  ) as RawFile;
const envelope = (): RawFile => fixture('vectors/envelope/basic.json');

// The envelope fixture with its first vector changed by `over`.
function withVector(over: Record<string, unknown>): RawFile {
  const file = envelope();
  file.vectors = [{ ...file.vectors[0], ...over }];
  return file;
}

const parse = (raw: unknown) => () => parseVectorFile(raw, 'basic.json');
const send = (extra: Record<string, unknown> = {}) => ({
  op: 'send',
  as: { address: 'human:wyat', canDecide: true },
  input: { to: ['human:ada'], kind: 'message', body: 'x' },
  ...extra,
});

describe('parseVectorFile', () => {
  it('accepts the fixture files', () => {
    for (const p of [
      'vectors/envelope/basic.json',
      'vectors/host-core/basic.json',
      'vectors/a2a-binding/basic.json',
      'vectors-envelope-only/envelope/basic.json',
    ]) {
      expect(parseVectorFile(fixture(p), p).vectors.length).toBeGreaterThan(0);
    }
  });

  it('refuses an id outside the id grammar', () => {
    expect(parse(withVector({ id: 'Env.basic.must' }))).toThrow('id ');
    expect(parse(withVector({ id: 'env.basic' }))).toThrow('id ');
  });

  it("refuses a vector whose class differs from the file's", () => {
    expect(parse(withVector({ class: 'host-core' }))).toThrow('class');
  });

  it('refuses an unknown level', () => {
    expect(parse(withVector({ level: 'SHALL' }))).toThrow('level');
  });

  it('requires a capability exactly on a MAY', () => {
    expect(parse(withVector({ level: 'MAY' }))).toThrow('capability');
    expect(parse(withVector({ capability: 'x-cap' }))).toThrow('capability');
  });

  it('refuses a section outside the section grammar', () => {
    expect(parse(withVector({ sections: ['3.x'] }))).toThrow('section');
    expect(parse(withVector({ sections: [] }))).toThrow('section');
  });

  it('refuses an unknown op and a step missing a required field', () => {
    expect(parse(withVector({ when: [{ op: 'teleport' }] }))).toThrow('op');
    expect(
      parse(withVector({ when: [send({ as: undefined })], then: {} }))
    ).toThrow('"as"');
  });

  it('refuses a message symbol that names no earlier creating step', () => {
    expect(
      parse(
        withVector({
          when: [send({ input: { replyTo: '$s2' } }), send()],
          then: {},
        })
      )
    ).toThrow('$s2');
    expect(
      parse(
        withVector({
          when: [{ op: 'parseAddress', input: 'human:wyat' }],
          then: { messages: [{ id: '$s1' }] },
        })
      )
    ).toThrow('$s1');
  });

  it('refuses then.steps longer than when and an unknown then key', () => {
    expect(
      parse(withVector({ then: { steps: [{ ok: true }, { ok: true }] } }))
    ).toThrow('steps');
    expect(parse(withVector({ then: { notes: [] } }))).toThrow('notes');
  });

  it('accepts null placeholders in then.steps', () => {
    expect(
      parseVectorFile(withVector({ then: { steps: [null] } }), 'basic.json')
        .vectors[0]?.then.steps
    ).toEqual([null]);
  });
});

describe('loadVectors', () => {
  let dir = '';
  afterEach(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  // A temporary kit directory holding `files` (path → JSON) under it.
  function kit(files: Record<string, unknown>): string {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'dmp-kit-')));
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), JSON.stringify(body));
    }
    return dir;
  }

  it('reads each class directory in order and the retired list', () => {
    const loaded = loadVectors(new URL('fixtures/vectors/', import.meta.url));
    expect(loaded.vectors.map((v) => v.id)).toEqual([
      'env.basic.must',
      'env.basic.should',
      'env.basic.may',
      'core.basic.must',
      'a2a.basic.must',
      'a2a.basic.dispatch-must',
    ]);
    expect(loaded.retired).toEqual([]);
  });

  it('refuses a duplicate id across two files', () => {
    const path = kit({
      'envelope/a.json': envelope(),
      'envelope/b.json': envelope(),
    });
    expect(() => loadVectors(path)).toThrow('duplicate');
  });

  it('refuses an id that is also retired', () => {
    const path = kit({
      'envelope/a.json': envelope(),
      'retired.json': { retired: [{ id: 'env.basic.may', reason: 'gone' }] },
    });
    expect(() => loadVectors(path)).toThrow('retired');
  });

  it('refuses a file whose class is not its directory', () => {
    const path = kit({ 'host-core/a.json': envelope() });
    expect(() => loadVectors(path)).toThrow('class');
  });

  it('refuses a directory that is not a vector class', () => {
    const path = kit({ 'host_core/a.json': envelope() });
    expect(() => loadVectors(path)).toThrow('host_core');
  });
});
