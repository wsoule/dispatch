import type { PolicyRuling } from '@dispatch/core';
import { beforeEach, describe, expect, it } from 'bun:test';

import { DocConflictError, DocsError } from '../../src/docs/errors.js';
import type { DocsService } from '../../src/docs/service.js';
import type { SqliteDocStore } from '../../src/docs/store.js';
import {
  AGENT,
  DECIDER,
  FakeDocsHost,
  makeService,
  OWNER,
  RUN,
  RUN2,
  TEAMMATE,
} from './fakeHost.js';

let service: DocsService;
let host: FakeDocsHost;
let store: SqliteDocStore;
beforeEach(() => {
  ({ service, host, store } = makeService());
  host.operators.set('human:wyat', {
    human: 'human:wyat',
    identity: 'id-wyat',
  });
  host.runs.set('run:r-1', {
    kind: 'execute',
    taskId: 't-1',
    operator: { human: 'human:wyat', identity: 'id-wyat' },
  });
});
const bigLines = (ch: string, kib: number): string =>
  `${ch.repeat(1023)}\n`.repeat(kib);
const as = (p: Parameters<DocsService['actorFor']>[0]) => service.actorFor(p);

function acceptedSpec(): string {
  service.create(as(OWNER), {
    title: 'Spec',
    body: '# Spec\n## API\nv1\n## Risks\nnone\n',
    links: [{ target: { type: 'task', id: 't-1' }, rel: 'spec' }],
  });
  service.setStatus(as(OWNER), 'spec', 'accepted');
  return 'spec';
}

describe('proposals', () => {
  it("turns a run's edit to an accepted doc into one proposal it keeps extending, reaching no other run", async () => {
    acceptedSpec();
    const first = service.edit(as(RUN), 'spec', {
      ops: [{ op: 'replace_section', section: 'API', text: 'v2' }],
    });
    expect(first.status).toBe('proposed');
    expect(await service.ensureGate(first.proposal ?? '')).toBe(
      host.gatesRaised[0]
    );
    const second = service.edit(as(RUN), 'spec', {
      ops: [{ op: 'append', section: 'API', text: 'more' }],
    });
    expect(second.proposal).toBe(first.proposal);
    expect(service.read(as(TEAMMATE), 'spec').text).toBe(
      '# Spec\n## API\nv1\n## Risks\nnone\n'
    );
    expect(
      service
        .revisions(as(OWNER), 'spec', {})
        .every((r) => r.cause !== 'proposal')
    ).toBe(true);
    expect(service.read(as(RUN), 'spec').proposal).toBe(first.proposal ?? null);
  });

  it('lets a decide-tier human write an accepted doc directly', () => {
    acceptedSpec();
    expect(
      service.edit(as(DECIDER), 'spec', { ops: [{ op: 'append', text: 'x' }] })
        .status
    ).toBe('saved');
  });

  it('auto-approves at rung 4 for a routine task, with the ledger receipt, and never for a task-less proposal', () => {
    acceptedSpec();
    host.ruling = (risk) =>
      risk === 'routine'
        ? ({
            mode: 'auto',
            gate: 'doc',
            rung: 4,
            authorizedBy: 'rung',
          } as PolicyRuling)
        : { mode: 'block' };
    const auto = service.edit(as(RUN), 'spec', {
      ops: [{ op: 'replace_section', section: 'API', text: 'auto' }],
    });
    expect(auto.status).toBe('saved');
    expect(service.read(as(OWNER), 'spec').text).toContain('## API\nauto\n');
    expect(host.policyApprovals).toHaveLength(1);
    const head = service.revisions(as(OWNER), 'spec', {})[0];
    expect(head).toMatchObject({
      cause: 'approve',
      author: 'agent:dispatch',
      unreviewed: true,
      approval: { by: 'agent:dispatch', policy: { rung: 4 } },
    });
    expect(
      service.edit(as(AGENT), 'spec', {
        ops: [{ op: 'append', text: 'agent' }],
      }).status
    ).toBe('proposed');
    expect(host.risksAsked.at(-1)).toBe('elevated');
  });

  it('answers a failed policy approval as the failure, not a gate-less proposal', () => {
    acceptedSpec();
    host.ruling = () => {
      // The doc is archived between the proposal's write and its approval.
      const row = store.doc(service.read(as(OWNER), 'spec').doc.id);
      if (row !== null) store.putDoc({ ...row, status: 'archived' });
      return { mode: 'auto', gate: 'doc', rung: 4, authorizedBy: 'rung' };
    };
    let err: unknown = null;
    try {
      service.edit(as(RUN), 'spec', { ops: [{ op: 'append', text: 'x' }] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DocsError);
    expect((err as DocsError).code).toBe('conflict');
    expect((err as DocsError).message).toContain('the doc was archived');
    expect(
      service.proposals(as(DECIDER), { state: ['failed'] }).map((p) => p.reason)
    ).toEqual(['the doc was archived']);
  });

  it("merges a head-based whole-body save onto the author's open proposal", () => {
    acceptedSpec();
    const head = service.read(as(RUN), 'spec').rev;
    const first = service.edit(as(RUN), 'spec', {
      ops: [{ op: 'replace_section', section: 'API', text: 'v2' }],
    });
    const saved = service.saveBody(as(RUN), 'spec', {
      baseRev: head.id,
      body: '# Spec\n## API\nv1\n## Risks\nsome\n',
    });
    expect(saved).toMatchObject({
      status: 'proposed',
      proposal: first.proposal,
    });
    expect(service.revision(as(RUN), 'spec', first.proposal ?? '').body).toBe(
      '# Spec\n## API\nv2\n## Risks\nsome\n'
    );
  });

  it("refuses a head-based save that conflicts with the author's open proposal, naming it", () => {
    acceptedSpec();
    const head = service.read(as(RUN), 'spec').rev;
    const first = service.edit(as(RUN), 'spec', {
      ops: [{ op: 'replace_section', section: 'API', text: 'v2' }],
    });
    let conflict: DocConflictError | null = null;
    try {
      service.saveBody(as(RUN), 'spec', {
        baseRev: head.id,
        body: '# Spec\n## API\nv3\n## Risks\nnone\n',
      });
    } catch (e) {
      if (e instanceof DocConflictError) conflict = e;
    }
    expect(conflict?.conflict).toMatchObject({
      reason: 'merge-conflict',
      head: {
        id: first.proposal,
        body: '# Spec\n## API\nv2\n## Risks\nnone\n',
      },
    });
    expect(service.revision(as(RUN), 'spec', first.proposal ?? '').body).toBe(
      '# Spec\n## API\nv2\n## Risks\nnone\n'
    );
  });

  it('limits proposals per hour per author', () => {
    acceptedSpec();
    host.config = { proposalsPerHour: 1, maxOpenProposals: 50 };
    service.edit(as(RUN), 'spec', { ops: [{ op: 'append', text: 'a' }] });
    service.create(as(OWNER), { title: 'Two', body: 'x\n' });
    service.setStatus(as(OWNER), 'two', 'accepted');
    const err = (() => {
      try {
        service.edit(as(RUN), 'two', { ops: [{ op: 'append', text: 'b' }] });
      } catch (e) {
        return e as DocsError;
      }
      return null;
    })();
    expect(err?.code).toBe('limited');
  });

  it('limits open proposals per project across authors', () => {
    acceptedSpec();
    host.config = { proposalsPerHour: 10, maxOpenProposals: 1 };
    expect(
      service.edit(as(RUN), 'spec', { ops: [{ op: 'append', text: 'a' }] })
        .status
    ).toBe('proposed');
    expect(() =>
      service.edit(as(AGENT), 'spec', { ops: [{ op: 'append', text: 'b' }] })
    ).toThrow('this project holds at most 1 open proposals');
    // The first author extends its own proposal; that is not a new one.
    expect(
      service.edit(as(RUN), 'spec', { ops: [{ op: 'append', text: 'c' }] })
        .status
    ).toBe('proposed');
  });

  it('answers conflict for a change equal to an open proposal the caller may see, naming it', () => {
    acceptedSpec();
    host.operators.set('human:alice', {
      human: 'human:alice',
      identity: 'id-alice',
    });
    host.runs.set('run:r-2', {
      kind: 'execute',
      taskId: 't-2',
      operator: { human: 'human:alice', identity: 'id-alice' },
    });
    const theirs = service.edit(as(RUN2), 'spec', {
      ops: [{ op: 'append', text: 'same' }],
    });
    expect(() =>
      service.edit(as(TEAMMATE), 'spec', {
        ops: [{ op: 'append', text: 'same' }],
      })
    ).toThrow(
      `the same change is already proposed as ${theirs.proposal ?? ''}`
    );
  });

  it('stores a change equal to a proposal the caller may not see as its own proposal, revealing nothing', () => {
    acceptedSpec();
    const hidden = service.edit(as(RUN), 'spec', {
      ops: [{ op: 'append', text: 'same' }],
    });
    const mine = service.edit(as(TEAMMATE), 'spec', {
      ops: [{ op: 'append', text: 'same' }],
    });
    expect(mine.status).toBe('proposed');
    expect(mine.proposal).not.toBe(hidden.proposal);
    expect(service.proposals(as(DECIDER), { state: ['open'] })).toHaveLength(2);
  });

  it('approves onto a moved head by diff3, and a human approval of a reviewed head stays reviewed', () => {
    acceptedSpec();
    const p = service.edit(as(RUN), 'spec', {
      ops: [{ op: 'replace_section', section: 'API', text: 'run v2' }],
    });
    service.edit(as(DECIDER), 'spec', {
      ops: [{ op: 'replace_section', section: 'Risks', text: 'human risk' }],
    });
    service.markReviewed(as(DECIDER), 'spec');
    expect(
      service.approveProposal(p.proposal ?? '', 'human:bob', null)
    ).toEqual({ ok: true });
    const read = service.read(as(OWNER), 'spec');
    expect(read.text).toBe('# Spec\n## API\nrun v2\n## Risks\nhuman risk\n');
    expect(read.doc.unreviewed).toBe(false);
    expect(
      service
        .revisions(as(OWNER), 'spec', {})
        .slice(0, 2)
        .map((r) => r.cause)
    ).toEqual(['approve', 'proposal']);
  });

  it('hands a decider the marked merge of a conflicting proposal, and none for a clean one', () => {
    acceptedSpec();
    const p = service.edit(as(RUN), 'spec', {
      ops: [{ op: 'replace_section', section: 'API', text: 'run' }],
    });
    expect(service.proposal(as(DECIDER), p.proposal ?? '').marked).toBeNull();
    service.edit(as(DECIDER), 'spec', {
      ops: [{ op: 'replace_section', section: 'API', text: 'human' }],
    });
    const view = service.proposal(as(DECIDER), p.proposal ?? '');
    expect(view.mergeable.clean).toBe(false);
    expect(view.marked).toContain('<<<<<<< ');
    expect(view.marked).toContain('human\n');
    expect(view.marked).toContain('run\n');
    expect(view.marked).toContain('>>>>>>> ');
  });

  it('fails an approval that conflicts, with a notice, and changes nothing', () => {
    acceptedSpec();
    const p = service.edit(as(RUN), 'spec', {
      ops: [{ op: 'replace_section', section: 'API', text: 'run' }],
    });
    service.edit(as(DECIDER), 'spec', {
      ops: [{ op: 'replace_section', section: 'API', text: 'human' }],
    });
    expect(
      service.approveProposal(p.proposal ?? '', 'human:bob', null)
    ).toEqual({ ok: false, reason: 'conflicts with rev 2' });
    expect(service.proposals(as(DECIDER), {})[0]).toMatchObject({
      state: 'failed',
      reason: 'conflicts with rev 2',
    });
    expect(host.notices.at(-1)?.body).toContain('conflicts with rev 2');
  });

  it('fails an approval whose merged body is over the limit, with a notice, and changes nothing', () => {
    acceptedSpec();
    const base = service.read(as(OWNER), 'spec');
    const p = service.saveBody(as(RUN), 'spec', {
      baseRev: base.rev.id,
      body: `${base.text}${bigLines('p', 400)}`,
    });
    expect(p.status).toBe('proposed');
    service.saveBody(as(DECIDER), 'spec', {
      baseRev: base.rev.id,
      body: `${bigLines('h', 400)}${base.text}`,
    });
    const headBefore = service.read(as(OWNER), 'spec').rev.id;
    expect(
      service.approveProposal(p.proposal ?? '', 'human:bob', null)
    ).toEqual({ ok: false, reason: 'merged body over the limit' });
    expect(service.proposals(as(DECIDER), {})[0]).toMatchObject({
      state: 'failed',
      reason: 'merged body over the limit',
    });
    expect(host.notices.at(-1)?.body).toContain('merged body over the limit');
    expect(service.read(as(OWNER), 'spec').rev.id).toBe(headBefore);
  });

  it('rejects with the answer as the reason, telling the live run', () => {
    acceptedSpec();
    const p = service.edit(as(RUN), 'spec', {
      ops: [{ op: 'append', text: 'x' }],
    });
    service.rejectProposal(p.proposal ?? '', 'human:bob', 'keep the v1 shape');
    expect(service.proposals(as(DECIDER), {})[0]).toMatchObject({
      state: 'rejected',
      reason: 'keep the v1 shape',
      decidedBy: 'human:bob',
    });
    expect(host.runLines.at(-1)).toEqual({
      runId: 'r-1',
      line: '📄 doc · spec: your proposal was rejected by human:bob: keep the v1 shape',
    });
  });

  it('announces a proposal made, rejected or expired as a meta change, so open pages refetch', async () => {
    acceptedSpec();
    const metas = () =>
      host.changes.filter((c) => c.kind === 'meta').map((c) => c.summary);
    const before = metas().length;
    const first = service.edit(as(RUN), 'spec', {
      ops: [{ op: 'append', text: 'x' }],
    });
    service.rejectProposal(first.proposal ?? '', 'human:bob', 'no');
    const second = service.edit(as(RUN), 'spec', {
      ops: [{ op: 'append', text: 'y' }],
    });
    await service.ensureGate(second.proposal ?? '');
    host.advance(14 * 24 * 60 + 1);
    service.sweep();
    expect(metas().slice(before)).toEqual([
      `proposal ${first.proposal} opened`,
      `proposal ${first.proposal} rejected`,
      `proposal ${second.proposal} opened`,
      `proposal ${second.proposal} expired`,
    ]);
  });

  it('expires in docs.db first, then closes the gate', async () => {
    acceptedSpec();
    const p = service.edit(as(RUN), 'spec', {
      ops: [{ op: 'append', text: 'x' }],
    });
    await service.ensureGate(p.proposal ?? '');
    host.advance(14 * 24 * 60 + 1);
    host.onCloseGate = () =>
      expect(service.proposals(as(DECIDER), {})[0].state).toBe('expired');
    service.sweep();
    expect(host.gatesClosed).toEqual([
      { gate: host.gatesRaised[0], reason: 'proposal expired' },
    ]);
  });

  it('withdraws open proposals on reopen, closing their gates', async () => {
    acceptedSpec();
    const p = service.edit(as(RUN), 'spec', {
      ops: [{ op: 'append', text: 'x' }],
    });
    await service.ensureGate(p.proposal ?? '');
    service.setStatus(as(DECIDER), 'spec', 'draft');
    expect(service.proposals(as(DECIDER), {})[0]).toMatchObject({
      state: 'withdrawn',
      reason: 'the doc was reopened as a draft; write to it directly',
    });
    expect(host.gatesClosed.map((g) => g.reason)).toEqual([
      'the doc was reopened as a draft; write to it directly',
    ]);
  });

  it('withdraws open proposals on archive, and an approve afterwards changes nothing', async () => {
    acceptedSpec();
    const p = service.edit(as(RUN), 'spec', {
      ops: [{ op: 'append', text: 'x' }],
    });
    await service.ensureGate(p.proposal ?? '');
    service.setStatus(as(DECIDER), 'spec', 'archived');
    expect(service.proposals(as(DECIDER), {})[0]).toMatchObject({
      state: 'withdrawn',
      reason: 'the doc was archived',
    });
    expect(host.gatesClosed.map((g) => g.reason)).toEqual([
      'the doc was archived',
    ]);
    expect(
      service.approveProposal(p.proposal ?? '', 'human:bob', null)
    ).toEqual({ ok: false, reason: 'the proposal is withdrawn' });
    expect(service.read(as(OWNER), 'spec').text).toBe(
      '# Spec\n## API\nv1\n## Risks\nnone\n'
    );
  });

  it('hard delete closes each gate while its proposal row still exists, then removes the rows', async () => {
    acceptedSpec();
    const p = service.edit(as(RUN), 'spec', {
      ops: [{ op: 'append', text: 'x' }],
    });
    await service.ensureGate(p.proposal ?? '');
    const seenAtClose: string[] = [];
    host.onCloseGate = () =>
      seenAtClose.push(
        service.proposalForGate(p.proposal ?? '')?.state ?? 'gone'
      );
    service.remove(as(DECIDER), 'spec');
    expect(seenAtClose).toEqual(['withdrawn']);
    expect(host.gatesClosed.map((g) => g.reason)).toEqual([
      'the doc was deleted',
    ]);
    expect(service.proposalForGate(p.proposal ?? '')).toBeNull();
  });

  it('shows proposal revisions only to those the proposal rows allow', () => {
    acceptedSpec();
    const p = service.edit(as(RUN), 'spec', {
      ops: [{ op: 'append', text: 'x' }],
    });
    expect(service.revision(as(RUN), 'spec', p.proposal ?? '').body).toContain(
      'x\n'
    );
    expect(
      service.revision(as(OWNER), 'spec', p.proposal ?? '').body
    ).toContain('x\n');
    for (const viewer of [TEAMMATE, AGENT]) {
      for (const look of [
        () => service.revision(as(viewer), 'spec', p.proposal ?? ''),
        () => service.proposal(as(viewer), p.proposal ?? ''),
        () => service.diff(as(viewer), 'spec', 1, p.proposal ?? ''),
        () => service.read(as(viewer), 'spec', { rev: p.proposal ?? '' }),
      ]) {
        let code: string | null = null;
        try {
          look();
        } catch (err) {
          if (err instanceof DocsError) code = err.code;
        }
        expect(code).toBe('not-found');
      }
      expect(service.proposals(as(viewer), {})).toEqual([]);
    }
    expect(service.proposal(as(DECIDER), p.proposal ?? '').mergeable).toEqual({
      clean: true,
      headN: 1,
    });
  });

  it('review focus 4: accepted specs stay put for everyone below decide tier', () => {
    acceptedSpec();
    const other = service.create(as(TEAMMATE), { title: 'Other', body: 'x\n' });
    expect(() =>
      service.link(as(TEAMMATE), other.doc.id, {
        target: { type: 'task', id: 't-1' },
        rel: 'spec',
        replace: true,
      })
    ).toThrow('decide-tier');
    expect(() =>
      service.unlink(as(TEAMMATE), 'spec', { type: 'task', id: 't-1' })
    ).toThrow('decide-tier');
    expect(
      service
        .link(as(TEAMMATE), other.doc.id, {
          target: { type: 'task', id: 't-1' },
          rel: 'plan',
        })
        .map((l) => l.rel)
    ).toEqual(['plan']);
  });

  it('accept seals and reviews the head and clears a restored mark', () => {
    const made = service.create(as(AGENT), { title: 'Agent doc', body: 'x\n' });
    const accepted = service.setStatus(as(DECIDER), 'agent-doc', 'accepted');
    expect(accepted).toMatchObject({
      status: 'accepted',
      unreviewed: false,
      head: { sealed: true },
    });
    const row = store.doc(made.doc.id);
    if (row === null) throw new Error('no doc row');
    store.putDoc({
      ...row,
      restoredStatus: 'accepted',
      restoredAt: '2026-09-26T09:00:00.000Z',
    });
    expect(service.read(as(DECIDER), 'agent-doc').doc.restored).toEqual({
      status: 'accepted',
      at: '2026-09-26T09:00:00.000Z',
    });
    expect(
      service.setStatus(as(DECIDER), 'agent-doc', 'accepted').restored
    ).toBeNull();
    expect(store.doc(made.doc.id)).toMatchObject({
      restoredStatus: null,
      restoredAt: null,
    });
  });
});
