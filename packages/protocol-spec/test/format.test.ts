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
      'vectors-separators/envelope/separators.json',
    ]) {
      expect(parseVectorFile(fixture(p), p).vectors.length).toBeGreaterThan(0);
    }
  });

  it('refuses an id outside the id grammar', () => {
    expect(parse(withVector({ id: 'Env.basic.must' }))).toThrow('id ');
    expect(parse(withVector({ id: 'env.basic' }))).toThrow('id ');
  });

  it("refuses an id whose prefix is not its class's", () => {
    expect(parse(withVector({ id: 'core.basic.must' }))).toThrow('prefix');
    expect(parse(withVector({ id: 'dmp.basic.must' }))).toThrow('prefix');
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

  it('refuses a render step whose form or external the kit does not know', () => {
    const render = (extra: Record<string, unknown>) =>
      withVector({ when: [{ op: 'render', message: 'm-x', ...extra }] });
    expect(parse(render({ form: 'digests' }))).toThrow(
      'step 1 (render) form must be "push" or "digest"'
    );
    expect(parse(render({ external: 'yes' }))).toThrow(
      'step 1 (render) external must be a boolean'
    );
    for (const extra of [
      {},
      { form: 'push', external: true },
      { form: 'digest' },
    ])
      expect(parse(render(extra))().vectors).toHaveLength(1);
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

  it('refuses an expectation row that compare could not read', () => {
    const render = { op: 'render', message: 'm-x' };
    const cases: [Record<string, unknown>, string][] = [
      [{ then: { steps: [{ ok: false }] } }, 'then.steps[0].error'],
      [{ then: { steps: [{ ok: false, error: {} }] } }, 'then.steps[0].error'],
      [
        {
          then: {
            steps: [{ ok: false, error: { code: 'invalid', field: 3 } }],
          },
        },
        'then.steps[0].error.field',
      ],
      [
        { then: { steps: [{ ok: true, error: { code: 'invalid' } }] } },
        'then.steps[0] has unknown field error',
      ],
      [
        { then: { deliveries: [{ recipient: 'human:ada' }] } },
        'then.deliveries[0].message',
      ],
      [
        { then: { deliveries: [{ message: 'm-x' }] } },
        'then.deliveries[0].recipient',
      ],
      [
        { then: { deliveries: [{ message: 'm-x', recipient: 'x', via: 3 }] } },
        'then.deliveries[0].via',
      ],
      [
        {
          then: {
            deliveries: [{ message: 'm-x', recipient: 'x', session: 3 }],
          },
        },
        'then.deliveries[0].session',
      ],
      [
        {
          then: {
            deliveries: [{ message: 'm-x', recipient: 'x', status: 'held' }],
          },
        },
        'then.deliveries[0] has unknown field status',
      ],
      [{ then: { channels: [{ name: 'auth' }] } }, 'then.channels[0]'],
      [
        { then: { channels: [{ name: 'auth', members: [1] }] } },
        'then.channels[0]',
      ],
      [
        { when: [render], then: { render: [{ step: 1 }] } },
        'then.render[0].text',
      ],
      [
        { when: [render], then: { render: [{ step: '1', text: 'x' }] } },
        'then.render[0].step',
      ],
      [{ then: { render: [{ step: 1, text: 'x' }] } }, 'then.render[0].step'],
      [
        { when: [render], then: { render: [{ step: 2, text: 'x' }] } },
        'then.render[0].step',
      ],
    ];
    const refused = cases.map(([over, why]) => {
      try {
        parseVectorFile(withVector(over), 'basic.json');
        return `accepted, expected ${why}`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return message.includes(why) ? 'refused' : message;
      }
    });
    expect(refused).toEqual(cases.map(() => 'refused'));
    expect(
      parseVectorFile(
        withVector({
          when: [render],
          then: {
            steps: [
              { ok: false, error: { code: 'not-found', field: 'message' } },
            ],
            deliveries: [
              { message: 'm-x', recipient: 'human:ada', session: null },
            ],
            channels: [{ name: 'auth', members: ['human:ada'] }],
            render: [{ step: 1, text: '' }],
          },
        }),
        'basic.json'
      ).vectors
    ).toHaveLength(1);
  });

  it('refuses a seeded store row compare could not read', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ store: [] }, 'given.store must be an object'],
      [{ store: { rows: [] } }, 'given.store has unknown field rows'],
      [{ store: { messages: {} } }, 'given.store.messages must be a list'],
      [{ store: { messages: [null] } }, 'given.store.messages[0]'],
      [{ store: { messages: [{ id: 3 }] } }, 'given.store.messages[0]'],
      [
        { store: { deliveries: [{ message: 'm-seed-x' }] } },
        'given.store.deliveries[0]',
      ],
      [{ store: { appliedGates: [1] } }, 'given.store.appliedGates'],
    ];
    const refused = cases.map(([given, why]) => {
      try {
        parseVectorFile(withVector({ given }), 'basic.json');
        return `accepted, expected ${why}`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return message.includes(why) ? 'refused' : message;
      }
    });
    expect(refused).toEqual(cases.map(() => 'refused'));
    expect(
      parseVectorFile(
        withVector({
          given: {
            store: {
              messages: [{ id: 'm-seed-x' }],
              deliveries: [{ id: 'd-seed-x', message: 'm-seed-x' }],
              appliedGates: ['m-seed-x'],
            },
          },
        }),
        'basic.json'
      ).vectors
    ).toHaveLength(1);
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
      'core.basic.system',
      'core.basic.gate',
      'core.basic.dispatch-must',
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
