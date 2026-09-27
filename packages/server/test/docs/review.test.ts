import { describe, expect, it } from 'bun:test';

import type { NewRevisionFacts } from '../../src/docs/review.js';
import {
  carriesUnreviewed,
  isTainted,
  unreviewedAtCreation,
} from '../../src/docs/review.js';

const clean = { unreviewed: false, reviewed: false };
const dirty = { unreviewed: true, reviewed: false };
const dirtyButReviewed = { unreviewed: true, reviewed: true };

function facts(over: Partial<NewRevisionFacts>): NewRevisionFacts {
  return {
    author: 'human:wyat',
    cause: 'save',
    approval: null,
    unverifiedVia: false,
    parents: [clean],
    ...over,
  };
}

describe('isTainted', () => {
  it('taints agents, runs, policy approvals, unverified syncs and restores', () => {
    expect(isTainted(facts({ author: 'run:r-1' }))).toBe(true);
    expect(isTainted(facts({ author: 'agent:wyat/claude-code.mac' }))).toBe(
      true
    );
    expect(
      isTainted(
        facts({
          author: 'agent:dispatch',
          cause: 'approve',
          approval: { by: 'agent:dispatch', policy: { rung: 4 } },
        })
      )
    ).toBe(true);
    expect(isTainted(facts({ unverifiedVia: true }))).toBe(true);
    expect(isTainted(facts({ cause: 'restore' }))).toBe(true);
    expect(isTainted(facts({}))).toBe(false);
  });

  it('adds no taint of its own for merges and sync folds, even when authored by the system', () => {
    expect(isTainted(facts({ author: 'agent:dispatch', cause: 'sync' }))).toBe(
      false
    );
    expect(isTainted(facts({ author: 'run:r-1', cause: 'merge' }))).toBe(false);
  });
});

describe('unreviewedAtCreation', () => {
  it("keeps an agent's text unreviewed through a human's later save", () => {
    const agentEdit = unreviewedAtCreation(
      facts({ author: 'run:r-1', cause: 'edit' })
    );
    expect(agentEdit).toBe(true);
    expect(
      unreviewedAtCreation(
        facts({ parents: [{ unreviewed: agentEdit, reviewed: false }] })
      )
    ).toBe(true);
  });

  it("keeps a clean merge of a human's stale buffer with an agent's edit unreviewed", () => {
    expect(
      unreviewedAtCreation(facts({ cause: 'merge', parents: [dirty, clean] }))
    ).toBe(true);
  });

  it('never flags a doc only humans wrote', () => {
    expect(unreviewedAtCreation(facts({ cause: 'create', parents: [] }))).toBe(
      false
    );
    expect(
      unreviewedAtCreation(facts({ cause: 'merge', parents: [clean, clean] }))
    ).toBe(false);
  });

  it('lets a review of the parent clear what came before', () => {
    expect(unreviewedAtCreation(facts({ parents: [dirtyButReviewed] }))).toBe(
      false
    );
  });

  it("gives a human's approval only its head parent's state", () => {
    const f = facts({
      cause: 'approve',
      approval: { by: 'human:wyat' },
      parents: [clean, dirty],
    });
    expect(unreviewedAtCreation(f)).toBe(false);
    expect(unreviewedAtCreation({ ...f, parents: [dirty, clean] })).toBe(true);
  });

  it('always flags a policy approval, since a rung is not a review', () => {
    expect(
      unreviewedAtCreation(
        facts({
          author: 'agent:dispatch',
          cause: 'approve',
          approval: { by: 'agent:dispatch', policy: { rung: 4 } },
          parents: [clean, clean],
        })
      )
    ).toBe(true);
  });

  it('flags a sync fold only when a parent carries the flag', () => {
    expect(
      unreviewedAtCreation(
        facts({
          author: 'agent:dispatch',
          cause: 'sync',
          parents: [clean, clean],
        })
      )
    ).toBe(false);
    expect(
      unreviewedAtCreation(
        facts({
          author: 'agent:dispatch',
          cause: 'sync',
          parents: [clean, dirty],
        })
      )
    ).toBe(true);
  });

  it('carries the flag of the revision a revert brings back', () => {
    expect(
      unreviewedAtCreation(facts({ cause: 'revert', restores: dirty }))
    ).toBe(true);
    expect(
      unreviewedAtCreation(
        facts({ cause: 'revert', restores: dirtyButReviewed })
      )
    ).toBe(false);
  });

  it('flags every restored revision', () => {
    expect(unreviewedAtCreation(facts({ cause: 'restore', parents: [] }))).toBe(
      true
    );
  });
});

describe('carriesUnreviewed', () => {
  it('is set only for an unreviewed revision nobody reviewed', () => {
    expect([clean, dirty, dirtyButReviewed].map(carriesUnreviewed)).toEqual([
      false,
      true,
      false,
    ]);
  });
});
