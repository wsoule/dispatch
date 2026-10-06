import { DEFAULT_MEMORY } from '@dispatch-foo/core';
import { describe, expect, it } from 'bun:test';

import { MemoryEngine, syncedEntryId, syncOrigin } from '../src/engine.js';
import { createMemoryIds } from '../src/records.js';
import type { ProposalContent } from '../src/types.js';
import { FakeMemoryHost, fakeStores } from './fakeHost.js';

// A team entry that arrived from a teammate's machine (federation F3).
const content: ProposalContent = {
  kind: 'hazard',
  title: 'pnpm 11 ignores onlyBuiltDependencies',
  body: 'use allowBuilds',
  refs: [],
  epic: null,
  appliesTo: [],
};

function setup() {
  const host = new FakeMemoryHost();
  const s = fakeStores();
  const engine = new MemoryEngine({
    stores: s.stores,
    host,
    config: () => DEFAULT_MEMORY,
  });
  const id = createMemoryIds().entry(Date.parse('2026-09-25T09:00:00.000Z'));
  return { engine, host, id, ...s };
}

describe('synced proposals (federation F3)', () => {
  it('names the entry in its origin, numbered after a decided attempt', () => {
    const id = 'mem-01K0000000000000000000000A';
    expect(syncOrigin('ada-0000000a', id, 1)).toBe(`sync:ada-0000000a:${id}`);
    expect(syncOrigin('ada-0000000a', id, 2)).toBe(`sync:ada-0000000a:${id}/2`);
    expect(syncedEntryId(syncOrigin('ada-0000000a', id, 2))).toBe(id);
    expect(syncedEntryId('ledger:x')).toBeNull();
  });

  it('stores nothing when local policy would approve it', () => {
    const t = setup();
    t.host.ruling = {
      mode: 'auto',
      gate: 'memory',
      rung: 4,
      authorizedBy: 'rung',
    };
    const out = t.engine.proposeSynced({
      id: t.id,
      origin: syncOrigin('ada-0000000a', t.id, 1),
      author: 'run:r-0000000000aa',
      content,
    });
    expect(out).toEqual({ status: 'auto' });
    expect(t.shared.listProposals()).toEqual([]);
    expect(t.host.gates).toEqual([]);
  });

  it('opens a gated proposal when local policy blocks, and approval keeps the replicated id', async () => {
    const t = setup();
    const origin = syncOrigin('ada-0000000a', t.id, 1);
    const out = t.engine.proposeSynced({
      id: t.id,
      origin,
      author: 'run:r-0000000000aa',
      content,
    });
    expect(out.status).toBe('proposed');
    if (out.status === 'proposed') await out.raised;
    const [p] = t.shared.listProposals({ states: ['open'] });
    expect(p).toMatchObject({
      action: 'add',
      scope: 'team',
      origin,
      author: 'run:r-0000000000aa',
      authorTrust: 'agent',
      gate: 'm-gate-1',
    });
    t.engine.reviseSyncedProposal(p.id, { ...content, body: 'edited there' });
    expect(t.shared.getProposal(p.id)?.content?.body).toBe('edited there');
    t.engine.applyGateAnswer({
      proposalId: p.id,
      gateId: 'm-gate-1',
      choice: 'approve',
      by: 'human:bob',
      reason: '',
      expired: false,
    });
    expect(t.shared.getEntry(t.id)).toMatchObject({
      id: t.id,
      body: 'edited there',
      trust: 'confirmed',
      decidedBy: 'human:bob',
      origin,
    });
  });

  it('leaves a decided proposal alone', async () => {
    const t = setup();
    const first = t.engine.proposeSynced({
      id: t.id,
      origin: syncOrigin('ada-0000000a', t.id, 1),
      author: 'run:r-0000000000aa',
      content,
    });
    if (first.status === 'proposed') await first.raised;
    const [p] = t.shared.listProposals();
    t.engine.applyGateAnswer({
      proposalId: p.id,
      gateId: 'm-gate-1',
      choice: 'reject',
      by: 'human:bob',
      reason: '',
      expired: false,
    });
    t.engine.reviseSyncedProposal(p.id, { ...content, body: 'later' });
    expect(t.shared.getProposal(p.id)?.content?.body).toBe(content.body);
  });

  it('applies an approved change to a held entry in place', async () => {
    const t = setup();
    const id = (await t.engine.save(
      { address: 'human:ada', canDecide: true, kind: 'human' },
      {
        scope: 'team',
        kind: 'hazard',
        title: content.title,
        body: content.body,
      }
    )) as { id: string };
    const out = t.engine.proposeSynced({
      id: id.id,
      origin: syncOrigin('ada-0000000a', id.id, 1),
      author: 'agent:dispatch',
      content,
      target: id.id,
      reason: 'pinned',
    });
    if (out.status !== 'proposed') throw new Error(out.status);
    await out.raised;
    expect(t.shared.getProposal(out.proposal)).toMatchObject({
      action: 'supersede',
      target: id.id,
      reason: 'pinned',
    });
    t.engine.applyGateAnswer({
      proposalId: out.proposal,
      gateId: 'm-gate-1',
      choice: 'approve',
      by: 'human:bob',
      reason: '',
      expired: false,
    });
    expect(t.shared.listEntries({ scopes: ['team'] }).map((e) => e.id)).toEqual(
      [id.id]
    );
    expect(t.shared.getEntry(id.id)).toMatchObject({
      status: 'active',
      decidedBy: 'human:bob',
      trust: 'confirmed',
    });
  });
});
