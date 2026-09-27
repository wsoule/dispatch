import { describe, expect, it } from 'bun:test';

import {
  prepareVector,
  stripThen,
  unimplementedGateType,
} from '../src/prepare.js';
import { loadRegistry } from '../src/registries.js';
import type { Registry, RegistryEntry } from '../src/registries.js';
import type { Hello, Vector } from '../src/types.js';

const hello: Hello = {
  dmp: 'hello',
  implementation: { name: 't', version: '0' },
  classes: ['envelope', 'host-core'],
  profiles: ['core'],
  capabilities: [],
  systemAddress: 'agent:dispatch',
  gateTypes: ['wake'],
  render: { quotePrefix: '> ', header: '^\\[from ', hostLines: [] },
};

function gate(value: string, status: RegistryEntry['status']): RegistryEntry {
  return {
    value,
    scope: 'dispatch',
    status,
    since: '1.0.0-draft.1',
    section: '5.9',
    vectors: [],
  };
}

// The kit's registry with its gate types replaced by `gates`.
function withGates(gates: RegistryEntry[]): Registry {
  return { ...loadRegistry(), 'gate-types': gates };
}

const registry = withGates([
  gate('wake', 'permanent'),
  gate('retired-type', 'reserved'),
  gate('tool-approval', 'provisional'),
  gate('memory', 'provisional'),
]);

const vector: Vector = {
  id: 'core.gates.fail-closed',
  title: 't',
  class: 'host-core',
  level: 'MUST',
  profile: 'core',
  sections: ['5.6'],
  given: { owner: '$system' },
  when: [
    {
      op: 'validate',
      as: { address: '$system', canDecide: true },
      input: {
        to: ['human:wyat'],
        kind: 'question',
        body: 'raised by $system, not $systemic',
        data: { type: '$unimplementedGateType' },
      },
    },
  ],
  then: {
    steps: [{ ok: false, error: { code: 'invalid', field: 'data.type' } }],
    messages: [{ from: '$system' }],
  },
};

describe('unimplementedGateType', () => {
  it('names the first registered type the adapter does not declare', () => {
    expect(unimplementedGateType(registry, hello)).toBe('tool-approval');
    expect(
      unimplementedGateType(registry, {
        ...hello,
        gateTypes: ['wake', 'tool-approval'],
      })
    ).toBe('memory');
  });

  it('never names a reserved type, and is null once every registered type is declared', () => {
    expect(
      unimplementedGateType(registry, {
        ...hello,
        gateTypes: ['wake', 'tool-approval', 'memory'],
      })
    ).toBeNull();
  });
});

describe('prepareVector', () => {
  it('replaces $system everywhere with the announced address, as a whole word', () => {
    const { vector: prepared, notApplicable } = prepareVector(
      vector,
      hello,
      registry
    );
    const step = prepared.when[0] as unknown as {
      as: { address: string };
      input: { body: string };
    };
    expect(notApplicable).toBe(false);
    expect(prepared.given.owner).toBe('agent:dispatch');
    expect(step.as.address).toBe('agent:dispatch');
    expect(step.input.body).toBe('raised by agent:dispatch, not $systemic');
    expect(prepared.then.messages).toEqual([{ from: 'agent:dispatch' }]);
  });

  it('JSON-escapes the announced address', () => {
    const { vector: prepared } = prepareVector(
      vector,
      { ...hello, systemAddress: 'agent:"quoted"\\' },
      registry
    );
    expect(prepared.given.owner).toBe('agent:"quoted"\\');
  });

  it('replaces $unimplementedGateType with a registered type the adapter does not declare', () => {
    const { vector: prepared } = prepareVector(vector, hello, registry);
    expect(prepared.when[0]?.['input']).toMatchObject({
      data: { type: 'tool-approval' },
    });
  });

  it('marks a vector needing an unimplemented gate type not applicable when none is left', () => {
    const all = { ...hello, gateTypes: ['wake', 'tool-approval', 'memory'] };
    expect(prepareVector(vector, all, registry).notApplicable).toBe(true);
    const plain: Vector = {
      ...vector,
      given: {},
      when: [{ op: 'parseAddress', input: '$system' }],
      then: {},
    };
    expect(prepareVector(plain, all, registry)).toEqual({
      vector: {
        ...plain,
        when: [{ op: 'parseAddress', input: 'agent:dispatch' }],
      },
      notApplicable: false,
    });
  });

  it('leaves the vector it was given untouched', () => {
    const before = JSON.stringify(vector);
    prepareVector(vector, hello, registry);
    expect(JSON.stringify(vector)).toBe(before);
  });
});

describe('stripThen', () => {
  it('drops the expectation and keeps everything else', () => {
    const runnable = stripThen(vector);
    expect('then' in runnable).toBe(false);
    const { then: _then, ...rest } = vector;
    expect(runnable).toEqual(rest);
    expect(vector.then.steps).toHaveLength(1);
  });
});
