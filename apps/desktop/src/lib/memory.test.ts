import type { MemoryProposalView } from '@dispatch/client';
import { describe, expect, it } from 'bun:test';

import { proposalCardModel } from './memory';
import type { Content } from './memory.test-helper';
import { content, entry, proposal } from './memory.test-helper';

describe('proposalCardModel', () => {
  it('shows what an add would save, who asked and from which task', () => {
    expect(
      proposalCardModel({ proposal: proposal(), base: null, current: null })
    ).toEqual({
      action: 'add',
      ask: 'Save this hazard to team memory?',
      title: 'pnpm 11 ignores onlyBuiltDependencies',
      kind: 'hazard',
      scope: 'team',
      reach: 'every run in this project, and teammates’',
      body: 'Use allowBuilds.',
      author: 'run:r-9f2c01',
      sourceTask: 't-1a2b3c',
      diff: null,
      matchedPersonal: false,
      note: null,
      decided: null,
    });
  });

  it('shows a supersede as a diff of the base and the proposed version', () => {
    const model = proposalCardModel({
      proposal: proposal({
        action: 'supersede',
        target: 'mem-000001',
        content: content({ body: 'new' }),
      }),
      base: entry({ body: 'old' }),
      current: entry({ body: 'old' }),
    });
    expect(model.ask).toBe('Replace a team hazard with this version?');
    expect(model.diff).toEqual({ base: 'old', proposed: 'new' });
  });

  it('shows a retire as the entry it would retire, and why', () => {
    const model = proposalCardModel({
      proposal: proposal({
        action: 'retire',
        scope: 'project',
        target: 'mem-000001',
        content: null,
        reason: 'fixed upstream',
      }),
      base: entry({ scope: 'project', kind: 'fact', title: 'proto shims' }),
      current: entry({ scope: 'project', kind: 'fact', title: 'proto shims' }),
    });
    expect(model).toMatchObject({
      action: 'retire',
      ask: 'Retire this project fact?',
      title: 'proto shims',
      kind: 'fact',
      body: 'old',
      reach: 'this machine only',
      note: 'fixed upstream',
      diff: null,
    });
  });

  it('says a match with a personal entry without showing that entry', () => {
    const model = proposalCardModel({
      proposal: proposal({ matchedPersonal: true }),
      base: null,
      current: null,
    });
    expect(model.matchedPersonal).toBe(true);
    expect(JSON.stringify(model)).not.toContain('personal entry body');
  });

  it('describes reach as the index does: task, epic, local, or everyone', () => {
    const reach = (
      over: Partial<Content>,
      scope: 'project' | 'team' = 'team'
    ) =>
      proposalCardModel({
        proposal: proposal({ scope, content: content(over) }),
        base: null,
        current: null,
      }).reach;
    expect(reach({ appliesTo: ['t-1a2b3c', 't-4d5e6f'] })).toBe(
      'these tasks: t-1a2b3c, t-4d5e6f'
    );
    expect(reach({ epic: 'e-000001' })).toBe('epic e-000001');
    expect(reach({}, 'project')).toBe('this machine only');
    expect(reach({})).toBe('every run in this project, and teammates’');
  });

  it('says how a proposal that no longer waits was decided', () => {
    const decided = (state: MemoryProposalView['state']) =>
      proposalCardModel({
        proposal: proposal({ state }),
        base: null,
        current: null,
      }).decided;
    expect(decided('approved')).toBe('approved');
    expect(decided('expired')).toBe('expired');
    expect(decided('open')).toBeNull();
  });
});
