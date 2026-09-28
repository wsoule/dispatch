import type { MemoryActivityRow, MemoryProposalView } from '@dispatch/client';
import { describe, expect, it } from 'bun:test';

import {
  activityItems,
  memoryQueryKey,
  memoryQueryRootKey,
  proposalCardModel,
} from './memory';
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

describe('memoryQueryKey', () => {
  it('keeps every memory query of one daemon under one root', () => {
    const root = memoryQueryRootKey(4321);
    expect(memoryQueryKey(4321, 'activity').slice(0, root.length)).toEqual([
      ...root,
    ]);
    expect(memoryQueryKey(4322, 'activity')).not.toEqual(
      memoryQueryKey(4321, 'activity')
    );
  });
});

describe('activityItems', () => {
  const row = (
    kind: MemoryActivityRow['kind'],
    over: Partial<MemoryActivityRow> = {}
  ): MemoryActivityRow => ({
    id: `ma-${kind}`,
    at: '2026-09-25T10:00:00.000Z',
    kind,
    memoryId:
      kind === 'throttled' || kind === 'ingest-problem' ? null : 'mem-1',
    runId: 'r-9f2c01',
    summary: `run:r-9f2c01 ${kind}`,
    ...over,
  });

  it('offers Undo for saves, edits, retires and ingests, and not for notices', () => {
    const kinds: MemoryActivityRow['kind'][] = [
      'saved',
      'edited',
      'retired',
      'ingested',
      'throttled',
      'ingest-problem',
    ];
    expect(
      activityItems(kinds.map((k) => row(k))).map((i) => i.undoable)
    ).toEqual([true, true, true, true, false, false]);
  });

  it('keeps the daemon’s order and its summary as the line', () => {
    const items = activityItems([
      row('saved', { id: 'ma-2', summary: 'run:r-1 saved to your memory: B' }),
      row('edited', { id: 'ma-1', summary: 'run:r-1 changed your memory: A' }),
    ]);
    expect(items).toEqual([
      {
        id: 'ma-2',
        memoryId: 'mem-1',
        text: 'run:r-1 saved to your memory: B',
        at: '2026-09-25T10:00:00.000Z',
        undoable: true,
      },
      {
        id: 'ma-1',
        memoryId: 'mem-1',
        text: 'run:r-1 changed your memory: A',
        at: '2026-09-25T10:00:00.000Z',
        undoable: true,
      },
    ]);
  });

  it('offers no Undo for a row that names no entry', () => {
    expect(activityItems([row('saved', { memoryId: null })])[0]?.undoable).toBe(
      false
    );
  });
});
