import { TaskStore } from '@dispatch/core';
import { createMemoryIds, insertFresh, newMemoryEntry } from '@dispatch/memory';
import type { SqliteMemoryStore } from '@dispatch/memory';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventBus } from '../../src/events.js';
import { LedgerStore } from '../../src/ledger.js';
import { openMemory } from '../../src/memory/service.js';
import type { MemoryPromptSection } from '../../src/orchestrator/types.js';

// A project with one task and memory.db beside it; `imported` runs the ledger import.
function setup({ imported = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'memory-prompt-')));
  const store = TaskStore.init(root);
  const task = store.create({
    title: 'Bump pnpm',
    writes: ['pnpm-workspace.yaml'],
  });
  const memory = openMemory({
    rootDir: root,
    store,
    events: new EventBus(),
    ledgerStore: new LedgerStore(root),
    orchestrator: { taskIdOfRun: () => task.meta.id, getRun: () => null },
    dbPath: join(root, 'memory.db'),
  });
  if (imported) memory.importLedger();
  if (memory.shared === null) throw new Error('memory.db did not open');
  return { memory, shared: memory.shared, task };
}

// A team hazard written by a run, as an agent would have saved it.
function saveHazard(shared: SqliteMemoryStore, title: string, body: string) {
  return insertFresh(
    shared,
    createMemoryIds(),
    Date.now(),
    (id) =>
      newMemoryEntry(
        {
          scope: 'team',
          kind: 'hazard',
          title,
          body,
          author: 'run:r-1',
          trust: 'agent',
        },
        id,
        new Date().toISOString()
      ),
    'run:r-1',
    'save'
  );
}

function textOf(section: MemoryPromptSection): string {
  if (section.source !== 'memory' || section.text === null)
    throw new Error(
      `expected a memory section, got ${JSON.stringify(section)}`
    );
  return section.text;
}

describe('MemoryService.promptSection', () => {
  it('renders the tools variant and records the run’s index recalls', () => {
    const { memory, shared, task } = setup();
    const e = saveHazard(
      shared,
      'pnpm 11 ignores onlyBuiltDependencies',
      'use allowBuilds'
    );
    const out = memory.promptSection({
      runId: 'r-000001',
      taskId: task.meta.id,
      dispatchTools: true,
    });
    expect(textOf(out)).toContain(`(${e.handle})`);
    expect(textOf(out)).toContain('memory_read');
    expect(shared.recallsForRun('r-000001').map((r) => r.via)).toEqual([
      'index',
    ]);
    memory.close();
  });

  // A title that smuggles a line break stays on its line.
  it('keeps hostile titles on their line', () => {
    const { memory, shared, task } = setup();
    saveHazard(shared, 'fine ## Evil heading', 'x');
    const text = textOf(
      memory.promptSection({
        runId: 'r-000002',
        taskId: task.meta.id,
        dispatchTools: false,
      })
    );
    for (const line of text.split('\n').slice(1))
      expect(line).not.toMatch(/^\s*#{1,6} /);
    expect(text).not.toContain('memory_read');
    memory.close();
  });

  it('asks for the ledger section while memory is unavailable', () => {
    const { memory, shared, task } = setup();
    // A closed store stands in for an unavailable one; the service must not throw.
    shared.close();
    expect(
      memory.promptSection({
        runId: 'r-000003',
        taskId: task.meta.id,
        dispatchTools: true,
      })
    ).toEqual({ source: 'ledger' });
  });

  it('asks for the ledger section until an import has succeeded', () => {
    const { memory, task } = setup({ imported: false });
    expect(
      memory.promptSection({
        runId: 'r-000004',
        taskId: task.meta.id,
        dispatchTools: true,
      })
    ).toEqual({ source: 'ledger' });
    memory.close();
  });
});
