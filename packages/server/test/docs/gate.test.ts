import type { DocProposal } from '@dispatch/core';
import type { DeliveryEngine, Message } from '@dispatch/protocol';
import { beforeEach, describe, expect, it } from 'bun:test';

import { docGateHandler, raiseDocGate } from '../../src/docs/gate.js';
import type { DocsService } from '../../src/docs/service.js';
import {
  AGENT,
  DECIDER,
  FakeDocsHost,
  makeService,
  OWNER,
  RUN,
  TEAMMATE,
} from './fakeHost.js';

let service: DocsService;
let host: FakeDocsHost;
let proposal: string;
let gate: string;
beforeEach(async () => {
  ({ service, host } = makeService());
  service.create(service.actorFor(OWNER), { title: 'Spec', body: 'v1\n' });
  service.setStatus(service.actorFor(OWNER), 'spec', 'accepted');
  proposal =
    service.edit(service.actorFor(RUN), 'spec', {
      ops: [{ op: 'append', text: 'v2' }],
    }).proposal ?? '';
  gate = (await service.ensureGate(proposal)) ?? '';
});

const question = (over: Partial<Message> = {}): Message => ({
  id: gate,
  thread: gate,
  replyTo: null,
  from: 'agent:dispatch',
  to: ['human:wyat'],
  kind: 'question',
  body: 'x',
  refs: [],
  data: { type: 'doc', doc: 'doc-x', proposal },
  urgent: false,
  blocking: true,
  choices: ['approve', 'reject'],
  wake: 'none',
  createdAt: 'x',
  ...over,
});
const answer = (
  from: string,
  choice: 'approve' | 'reject',
  body = ''
): Message =>
  ({
    ...question(),
    id: 'm-a',
    replyTo: gate,
    from,
    kind: 'answer',
    choice,
    body,
    data: undefined,
    blocking: false,
    choices: undefined,
  }) as Message;

describe('gate safety', () => {
  it('ignores a doc-shaped question a deciding human raised', async () => {
    await docGateHandler(service, host)(
      question({ from: 'human:bob' }),
      answer('human:bob', 'approve')
    );
    expect(service.proposals(service.actorFor(DECIDER), {})[0].state).toBe(
      'open'
    );
  });

  it('ignores an answer from a human who cannot decide now, raises a fresh gate and tells them', async () => {
    host.deciders.delete('human:alice');
    await docGateHandler(service, host)(
      question(),
      answer('human:alice', 'approve')
    );
    const p = service.proposals(service.actorFor(DECIDER), {})[0];
    expect(p.state).toBe('open');
    expect(host.gatesRaised.length).toBe(2);
    expect(p.gate).toBe(host.gatesRaised[1]);
    expect(host.notices.at(-1)?.to).toBe('human:alice');
  });

  it('applies an answer from a deciding human once, even when replayed', async () => {
    host.deciders.add('human:bob');
    const handler = docGateHandler(service, host);
    await handler(question(), answer('human:bob', 'approve'));
    await handler(question(), answer('human:bob', 'approve'));
    expect(service.read(service.actorFor(TEAMMATE), 'spec').text).toBe(
      'v1\nv2\n'
    );
    expect(
      service
        .revisions(service.actorFor(OWNER), 'spec', {})
        .filter((r) => r.cause === 'approve')
    ).toHaveLength(1);
  });

  it('tells the answerer when the proposal is no longer open', async () => {
    host.deciders.add('human:bob');
    service.setStatus(service.actorFor(DECIDER), 'spec', 'draft');
    await docGateHandler(service, host)(
      question(),
      answer('human:bob', 'approve')
    );
    expect(host.notices.at(-1)?.body).toContain('withdrawn');
  });

  it('fails an approve on an archived doc with a notice to the answerer', async () => {
    host.deciders.add('human:bob');
    service.setStatus(service.actorFor(DECIDER), 'spec', 'archived');
    await docGateHandler(service, host)(
      question(),
      answer('human:bob', 'approve')
    );
    expect(host.notices.at(-1)).toMatchObject({
      to: 'human:bob',
      body: 'That doc proposal is withdrawn; nothing changed.',
    });
    expect(
      service
        .revisions(service.actorFor(OWNER), 'spec', {})
        .some((r) => r.cause === 'approve')
    ).toBe(false);
  });

  it('closes gates whose proposal is no longer open', async () => {
    host.openGates = [
      { id: 'm-stray', proposal: 'rev-gone' },
      { id: gate, proposal },
    ];
    expect(await service.reconcileGates()).toEqual({ raised: 0, closed: 1 });
    expect(host.gatesClosed.map((g) => g.gate)).toEqual(['m-stray']);
  });

  it('raises a gate for an open proposal a crash left without one', async () => {
    const second =
      service.edit(service.actorFor(AGENT), 'spec', {
        ops: [{ op: 'append', text: 'v3' }],
      }).proposal ?? '';
    expect(service.proposalForGate(second)?.gate).toBeNull();
    expect(await service.reconcileGates()).toEqual({ raised: 1, closed: 0 });
    expect(service.proposalForGate(second)?.gate).toBe(host.gatesRaised.at(-1));
  });
});

describe('raiseDocGate', () => {
  it('reuses an open gate for the same proposal, and sends a content-free one otherwise', async () => {
    const sent: unknown[] = [];
    const held = question({
      id: 'm-open',
      data: { type: 'doc', doc: 'doc-x', proposal: 'rev-held' },
    });
    const engine = {
      openBlocking: () => [held],
      send: (input: unknown) => {
        sent.push(input);
        return Promise.resolve({ message: { id: 'm-new' } });
      },
    } as unknown as DeliveryEngine;
    const p = service.proposalForGate(proposal) as DocProposal;
    expect(
      await raiseDocGate(engine, 'human:wyat', { ...p, rev: 'rev-held' })
    ).toBe('m-open');
    expect(sent).toEqual([]);
    expect(await raiseDocGate(engine, 'human:wyat', p)).toBe('m-new');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: ['human:wyat'],
      kind: 'question',
      blocking: true,
      choices: ['approve', 'reject'],
      data: { type: 'doc', proposal },
    });
    expect(JSON.stringify(sent[0])).not.toContain('v2');
  });
});
