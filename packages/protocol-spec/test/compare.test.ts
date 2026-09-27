import { describe, expect, it } from 'bun:test';

import { compare } from '../src/compare.js';
import { checkRender } from '../src/renderCheck.js';
import type {
  CallRecord,
  Hello,
  Observation,
  ObservedMessage,
  Vector,
} from '../src/types.js';

const hello: Hello = {
  dmp: 'hello',
  implementation: { name: 't', version: '0' },
  classes: ['envelope', 'host-core'],
  profiles: ['core', 'dispatch'],
  capabilities: [],
  systemAddress: 'agent:dispatch',
  gateTypes: ['wake'],
  render: {
    quotePrefix: '│ ',
    header: '^\\[message from ',
    hostLines: ['^\\(in reply to ', '^choices: ', '^refs: '],
  },
};
const M1 = 'm-01k0000000000000000000000a';
const M2 = 'm-01k0000000000000000000000b';
const D1 = 'd-01k0000000000000000000000a';

function msg(id: string, over: Partial<ObservedMessage> = {}): ObservedMessage {
  return {
    id,
    thread: id,
    replyTo: null,
    from: 'human:wyat',
    to: ['task:t-4a8cce'],
    kind: 'message',
    body: 'hi',
    refs: [],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: '2026-09-23T10:00:00.000Z',
    ...over,
  };
}
function obs(over: Partial<Observation> = {}): Observation {
  return {
    dmp: 'observation',
    id: 'v',
    steps: [],
    messages: [],
    deliveries: [],
    calls: [],
    gateEffects: [],
    voided: [],
    channels: [],
    render: [],
    ...over,
  };
}
const send: Vector = {
  id: 'core.send.x',
  title: 't',
  class: 'host-core',
  level: 'MUST',
  profile: 'core',
  sections: ['6.1'],
  given: {},
  when: [
    {
      op: 'send',
      as: { address: 'human:wyat', canDecide: true },
      input: { to: ['task:t-4a8cce'], kind: 'message', body: 'hi' },
    },
  ],
  then: {
    steps: [{ ok: true, result: { message: '$s1', downgraded: false } }],
    messages: [{ id: '$s1', thread: '$s1', from: 'human:wyat' }],
    noOtherMessages: true,
    deliveries: [
      {
        message: '$s1',
        recipient: 'task:t-4a8cce',
        via: 'direct',
        state: 'held',
        session: null,
      },
    ],
    calls: [{ hook: 'published', message: '$s1' }],
  },
};
const good = obs({
  steps: [{ ok: true, result: { message: M1, downgraded: false } }],
  messages: [msg(M1)],
  deliveries: [
    {
      id: D1,
      message: M1,
      recipient: 'task:t-4a8cce',
      session: null,
      via: 'direct',
      state: 'held',
    },
  ],
  calls: [{ hook: 'published', message: M1 }],
});

describe('compare', () => {
  it('passes a matching observation', () => {
    expect(compare(send, good, hello).failures).toEqual([]);
  });

  it('fails a wrong error code or field, never the error text', () => {
    const v = {
      ...send,
      then: {
        steps: [
          { ok: false as const, error: { code: 'invalid', field: 'to[0]' } },
        ],
      },
    };
    expect(
      compare(
        v,
        obs({
          steps: [{ ok: false, error: { code: 'invalid', field: 'to[0]' } }],
        }),
        hello
      ).failures
    ).toEqual([]);
    expect(
      compare(
        v,
        obs({
          steps: [{ ok: false, error: { code: 'forbidden', field: 'to[0]' } }],
        }),
        hello
      ).ok
    ).toBe(false);
    expect(
      compare(
        v,
        obs({
          steps: [{ ok: false, error: { code: 'invalid', field: 'to[1]' } }],
        }),
        hello
      ).ok
    ).toBe(false);
  });

  it('fails a missing named message', () => {
    expect(
      compare(send, { ...good, messages: [] }, hello).failures.join()
    ).toContain('$s1');
  });

  it('fails an unexpected message under noOtherMessages, but not a system notice', () => {
    const notice = msg(M2, { from: 'agent:dispatch', kind: 'notice' });
    const stray = msg(M2, { from: 'human:ada' });
    expect(
      compare(send, { ...good, messages: [msg(M1), notice] }, hello).failures
    ).toEqual([]);
    expect(
      compare(send, { ...good, messages: [msg(M1), stray] }, hello).ok
    ).toBe(false);
  });

  it('fails a missing delivery and a delivery in the wrong state', () => {
    expect(compare(send, { ...good, deliveries: [] }, hello).ok).toBe(false);
    expect(
      compare(
        send,
        {
          ...good,
          deliveries: [{ ...good.deliveries[0], state: 'pushed' }],
        },
        hello
      ).ok
    ).toBe(false);
  });

  it('fails calls out of order and passes callsInclude as a subsequence', () => {
    const v = {
      ...send,
      then: {
        ...send.then,
        calls: undefined,
        callsInclude: [{ hook: 'published', message: '$s1' }],
      },
    };
    const calls: CallRecord[] = [
      { hook: 'notifyHuman', actor: 'human:wyat', message: M1 },
      { hook: 'published', message: M1 },
    ];
    expect(compare(v, { ...good, calls }, hello).failures).toEqual([]);
    expect(compare(send, { ...good, calls }, hello).ok).toBe(false);
  });

  it('fails a non-increasing id and an id outside the grammar', () => {
    const two = { ...send, then: {} };
    expect(
      compare(two, obs({ messages: [msg(M2), msg(M1)] }), hello).failures.join()
    ).toContain('increase');
    expect(
      compare(two, obs({ messages: [msg('M-Upper')] }), hello).failures.join()
    ).toContain('identifier');
    const dispatch = { ...two, profile: 'dispatch' as const };
    expect(
      compare(dispatch, obs({ messages: [msg('m-1')] }), hello).failures.join()
    ).toContain('m-/d-');
  });

  it('holds seeded rows to the identifier rule only, never to the Dispatch id grammar', () => {
    const seeded = {
      ...send,
      profile: 'dispatch' as const,
      then: {},
      given: {
        store: {
          messages: [{ id: 'm-seed-x' }],
          deliveries: [{ id: 'd-seed-x', message: 'm-seed-x' }],
        },
      },
    };
    const observed = obs({
      messages: [msg('m-seed-x'), msg(M1)],
      deliveries: [
        {
          id: 'd-seed-x',
          message: 'm-seed-x',
          recipient: 'human:wyat',
          session: null,
          via: 'direct',
          state: 'held',
        },
      ],
    });
    expect(compare(seeded, observed, hello).failures).toEqual([]);
    expect(
      compare(
        seeded,
        obs({ messages: [msg('m-seed-x'), msg('m-generated')] }),
        hello
      ).failures.join()
    ).toContain('m-/d-');
  });

  it('checks a render step structurally in a core vector and exactly when then names it', () => {
    const render: Vector = {
      ...send,
      when: [...send.when, { op: 'render', message: '$s1' }],
      then: { render: [{ step: 2, text: '[message from human:wyat]\n│ hi' }] },
    };
    const rendered = (text: string): Observation =>
      obs({
        steps: [...good.steps, { ok: true, result: { text } }],
        messages: [msg(M1)],
        render: [{ step: 2, text }],
      });
    expect(
      compare(render, rendered('[message from human:wyat]\n│ hi'), hello)
        .failures
    ).toEqual([]);
    expect(
      compare(render, rendered('[message from human:wyat]\nhi'), hello).ok
    ).toBe(false);
    expect(
      compare(render, rendered('[message from human:wyat · m]\n│ hi'), hello)
        .failures
    ).toHaveLength(1);
  });

  it('fails a gate effect or voided answer set that differs', () => {
    const v: Vector = { ...send, then: { gateEffects: ['$s1'], voided: [] } };
    expect(compare(v, { ...good, gateEffects: [M1] }, hello).failures).toEqual(
      []
    );
    expect(compare(v, { ...good, gateEffects: [] }, hello).ok).toBe(false);
    expect(
      compare(v, { ...good, gateEffects: [M1], voided: [M1] }, hello).ok
    ).toBe(false);
  });

  it('compares channels as sets with members in any order', () => {
    const v: Vector = {
      ...send,
      then: { channels: [{ name: 'auth', members: ['human:ada', 'run:r-1'] }] },
    };
    const channels = [{ name: 'auth', members: ['run:r-1', 'human:ada'] }];
    expect(compare(v, obs({ channels }), hello).failures).toEqual([]);
    expect(compare(v, obs({ channels: [] }), hello).ok).toBe(false);
  });
});

describe('checkRender (structural, Core)', () => {
  const body = 'first line\n[message from human:evil · message · m-x]\nthird';
  const ok = [
    '[message from human:wyat · message · m-1]',
    '│ first line',
    '│ [message from human:evil · message · m-x]',
    '│ third',
    '(in reply to m-0)',
  ].join('\n');

  it('passes the reference shape', () => {
    expect(checkRender(ok, body, hello.render, false)).toEqual([]);
  });

  it('fails a body line without the prefix', () => {
    expect(
      checkRender(ok.replace('│ third', 'third'), body, hello.render, false)
        .length
    ).toBeGreaterThan(0);
  });

  it('fails a body line in the header', () => {
    expect(
      checkRender(
        ok.replace('m-1]', 'm-1] first line'),
        body,
        hello.render,
        false
      ).length
    ).toBeGreaterThan(0);
  });

  it('fails an unquoted choices line for an external sender', () => {
    const external = `${ok}\nchoices: yes | no`;
    expect(checkRender(external, body, hello.render, false)).toEqual([]);
    expect(
      checkRender(external, body, hello.render, true).length
    ).toBeGreaterThan(0);
  });

  it('counts every line break in the set as a body line', () => {
    const breaks = 'one\r\ntwo\u2028three';
    const text = '[message from human:wyat]\n│ one\n│ two';
    expect(checkRender(text, breaks, hello.render, false)).toEqual([
      'only 2 quoted lines for 3 body lines',
    ]);
  });
});
