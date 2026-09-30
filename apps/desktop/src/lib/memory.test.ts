import type { MemoryActivityRow, MemoryProposalView } from '@dispatch/client';
import { describe, expect, it } from 'bun:test';

import {
  activityItems,
  entryProvenance,
  memoryQueryKey,
  memoryQueryRootKey,
  memorySettingsModel,
  proposalCardModel,
} from './memory';
import type { Content } from './memory.test-helper';
import { content, entry, health, proposal, report } from './memory.test-helper';

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

  it('shows a supersede as the current and the proposed version', () => {
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
    expect(model.diff).toEqual({
      current: { title: 'pnpm builds', body: 'old' },
      base: null,
      proposed: { title: 'pnpm 11 ignores onlyBuiltDependencies', body: 'new' },
      retired: false,
    });
  });

  it('shows the version proposed against beside the current one once the entry changed', () => {
    const model = proposalCardModel({
      proposal: proposal({
        action: 'supersede',
        target: 'mem-000001',
        baseRev: 1,
        content: content({ body: 'agent version' }),
      }),
      base: entry({ rev: 1, body: 'old' }),
      current: entry({ rev: 2, body: 'human fix' }),
    });
    expect(model.diff).toMatchObject({
      current: { body: 'human fix' },
      base: { body: 'old' },
      proposed: { body: 'agent version' },
    });
  });

  // Pinning, confirming and decay each add a revision but change nothing shown.
  it('shows no version proposed against when only the revision moved', () => {
    const model = proposalCardModel({
      proposal: proposal({
        action: 'supersede',
        target: 'mem-000001',
        baseRev: 1,
        content: content({ body: 'agent version' }),
      }),
      base: entry({ rev: 1 }),
      current: entry({
        rev: 4,
        pinned: true,
        trust: 'confirmed',
        decay: 'stale',
      }),
    });
    expect(model.diff?.base).toBeNull();
  });

  it('shows the version proposed against when only its title changed', () => {
    const model = proposalCardModel({
      proposal: proposal({
        action: 'supersede',
        target: 'mem-000001',
        baseRev: 1,
        content: content({ body: 'agent version' }),
      }),
      base: entry({ rev: 1, title: 'pnpm builds' }),
      current: entry({ rev: 2, title: 'pnpm 11 builds' }),
    });
    expect(model.diff).toMatchObject({
      base: { title: 'pnpm builds', body: 'old' },
      current: { title: 'pnpm 11 builds', body: 'old' },
    });
  });

  // Approving retires the target only while it is active, so nothing is replaced.
  it('says a supersede’s entry was retired since it was proposed', () => {
    const model = proposalCardModel({
      proposal: proposal({
        action: 'supersede',
        target: 'mem-000001',
        baseRev: 1,
        content: content({ body: 'agent version' }),
      }),
      base: entry({ rev: 1 }),
      current: entry({
        rev: 2,
        status: 'retired',
        statusReason: 'forgotten',
        state: 'retired',
      }),
    });
    expect(model.diff).toMatchObject({ base: null, retired: true });
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
    // Each change names its own entry; the notices name none.
    const rows = kinds.map((k, i) => {
      const r = row(k);
      return r.memoryId === null ? r : { ...r, memoryId: `mem-${i}` };
    });
    expect(
      Object.fromEntries(activityItems(rows).map((i) => [i.id, i.undoable]))
    ).toEqual({
      'ma-saved': true,
      'ma-edited': true,
      'ma-retired': true,
      'ma-ingested': true,
      'ma-throttled': false,
      'ma-ingest-problem': false,
    });
  });

  it('lists the daemon’s oldest-first rows newest first, its summary as the line', () => {
    const items = activityItems([
      row('edited', {
        id: 'ma-1',
        at: '2026-09-25T09:00:00.000Z',
        memoryId: 'mem-2',
        summary: 'run:r-1 changed your memory: A',
      }),
      row('saved', { id: 'ma-2', summary: 'run:r-1 saved to your memory: B' }),
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
        memoryId: 'mem-2',
        text: 'run:r-1 changed your memory: A',
        at: '2026-09-25T09:00:00.000Z',
        undoable: true,
      },
    ]);
  });

  it('offers Undo only on the newest change to each entry, since undo reverts the latest', () => {
    const items = activityItems([
      row('saved', { id: 'ma-1', memoryId: 'mem-1' }),
      row('saved', { id: 'ma-2', memoryId: 'mem-2' }),
      row('edited', { id: 'ma-3', memoryId: 'mem-1' }),
    ]);
    expect(items.map((i) => [i.id, i.undoable])).toEqual([
      ['ma-3', true],
      ['ma-2', true],
      ['ma-1', false],
    ]);
  });

  // What `MemoryEngine.activity` returns after a run saves an entry, then changes it.
  it('puts Undo on the change undo reverts, given rows as the daemon returns them', () => {
    const daemon: MemoryActivityRow[] = [
      {
        id: 'ma-01',
        at: '2026-09-25T10:00:00.000Z',
        kind: 'saved',
        memoryId: 'mem-01',
        runId: 'r-9f2c01',
        summary: 'run:r-9f2c01 saved to your memory: pnpm builds',
      },
      {
        id: 'ma-02',
        at: '2026-09-25T10:00:00.000Z',
        kind: 'ingested',
        memoryId: 'mem-01',
        runId: 'r-9f2c01',
        summary: 'run:r-9f2c01 changed your memory: pnpm builds',
      },
    ];
    expect(activityItems(daemon).map((i) => [i.text, i.undoable])).toEqual([
      ['run:r-9f2c01 changed your memory: pnpm builds', true],
      ['run:r-9f2c01 saved to your memory: pnpm builds', false],
    ]);
  });

  it('offers no Undo for a row that names no entry', () => {
    expect(activityItems([row('saved', { memoryId: null })])[0]?.undoable).toBe(
      false
    );
  });
});

describe('memorySettingsModel', () => {
  it('surfaces config warnings, the parity report, an unconfirmed Claude import and pinned overflow', () => {
    const model = memorySettingsModel(
      health({
        configWarnings: [
          {
            key: 'memory.indexTokens',
            message:
              'memory.indexTokens must be an integer from 200 to 4000; using 1000',
          },
        ],
        ledgerImport: report({ outcome: 'ok' }),
        claudeImport: {
          state: 'unconfirmed',
          source: null,
          candidates: ['/Users/x/.claude/projects/-a/memory'],
          problems: [],
        },
        personal: {
          available: false,
          reason: 'personal memory unavailable: database is locked',
        },
        pinnedOverflow: true,
      })
    );
    expect(model).toMatchObject({
      status: 'ok',
      claudeImport: 'unconfirmed',
      candidates: ['/Users/x/.claude/projects/-a/memory'],
      personalUnavailable: 'personal memory unavailable: database is locked',
      pinnedOverflow: true,
    });
    expect(model.warnings).toEqual([
      'memory.indexTokens must be an integer from 200 to 4000; using 1000',
    ]);
    expect(
      memorySettingsModel(
        health({ available: false, reason: 'too new', claudeImport: null })
      ).status
    ).toBe('unavailable');
    expect(
      memorySettingsModel(health({ claudeImport: null })).claudeImport
    ).toBe('unknown');
  });

  it('shows the daemon’s own parity report', () => {
    expect(
      memorySettingsModel(
        health({ ledgerImport: report(), ledgerImportText: 'outcome: ok' })
      ).parityText
    ).toBe('outcome: ok');
    expect(memorySettingsModel(health()).parityText).toBeNull();
  });

  it('says what the store holds, or why it is closed', () => {
    expect(memorySettingsModel(health()).store).toBe(
      '15 entries · 2 open proposals · full-text search'
    );
    expect(
      memorySettingsModel(
        health({ entries: 1, openProposals: 0, search: 'like' })
      ).store
    ).toBe('1 entry · no open proposals · plain search (no FTS5)');
    expect(
      memorySettingsModel(
        health({
          available: false,
          reason: 'memory.db is from a newer Dispatch',
        })
      ).store
    ).toBe('Unavailable: memory.db is from a newer Dispatch');
  });

  it('names the Claude notes’ source once imported, and a null state as unknown', () => {
    expect(memorySettingsModel(health())).toMatchObject({
      claudeImport: 'complete',
      claudeSource: '/Users/x/.claude/projects/-a/memory',
    });
    expect(
      memorySettingsModel(
        health({
          claudeImport: {
            state: null,
            source: null,
            candidates: [],
            problems: [],
          },
        })
      ).claudeImport
    ).toBe('unknown');
    expect(
      memorySettingsModel(health({ personal: null })).personalUnavailable
    ).toBeNull();
  });
});

describe('entryProvenance', () => {
  it('names the scope and kind, who wrote it, who approved it, and its trust', () => {
    expect(
      entryProvenance(
        entry({
          author: 'run:r-9f2c01',
          trust: 'agent',
          decidedBy: 'human:wyat',
        })
      )
    ).toBe(
      'Team hazard · by run:r-9f2c01 · approved by human:wyat · agent-written'
    );
    expect(
      entryProvenance(
        entry({
          author: 'run:r-9f2c01',
          trust: 'agent',
          decidedByPolicy: { rung: 4, authorizedBy: 'rung' },
        })
      )
    ).toBe(
      'Team hazard · by run:r-9f2c01 · approved by policy at rung 4 · agent-written'
    );
    expect(entryProvenance(entry({ scope: 'project', kind: 'fact' }))).toBe(
      'Project fact · by human:wyat · human-written'
    );
  });

  it('says where an imported entry came from, and whether it is stale or pinned', () => {
    expect(
      entryProvenance(
        entry({
          origin: 'ledger:l-000001@2026-09-01T00:00:00.000Z',
          author: 'agent:dispatch',
          trust: 'agent',
          state: 'stale',
          pinned: true,
        })
      )
    ).toBe('Team hazard · from the ledger · unreviewed · stale · pinned');
    expect(
      entryProvenance(
        entry({
          scope: 'personal',
          origin: 'claude:dispatch/feedback.md',
          trust: 'confirmed',
        })
      )
    ).toBe('Personal hazard · from your Claude notes · confirmed');
    expect(
      entryProvenance(
        entry({ origin: 'amendment:a-1@2026-09-01', trust: 'human' })
      )
    ).toBe('Team hazard · from a task amendment · human-written');
  });
});
