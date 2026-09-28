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
import { quietDaemon } from './fixtures.js';

// A project with one task and memory.db beside it; `imported` runs the ledger import.
function setup({ imported = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'memory-prompt-')));
  const store = TaskStore.init(root);
  const task = store.create({
    title: 'Bump pnpm',
    writes: ['pnpm-workspace.yaml'],
  });
  // Each call opens the same memory.db again, as a daemon restart would.
  const open = () =>
    openMemory({
      rootDir: root,
      store,
      events: new EventBus(),
      ledgerStore: new LedgerStore(root),
      ...quietDaemon(root, { taskIdOfRun: () => task.meta.id }),
      dbPath: join(root, 'memory.db'),
    });
  const memory = open();
  if (imported) memory.importLedger();
  if (memory.shared === null) throw new Error('memory.db did not open');
  return { memory, shared: memory.shared, task, open };
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

  // A busy database costs the run's recall rows, never its index.
  it('keeps the index when recording its recalls fails', () => {
    const { memory, shared, task } = setup();
    const e = saveHazard(shared, 'pnpm 11 ignores onlyBuiltDependencies', 'x');
    shared.recordRecall = () => {
      throw new Error('SQLITE_BUSY: database is locked');
    };
    const out = memory.promptSection({
      runId: 'r-000008',
      taskId: task.meta.id,
      dispatchTools: true,
    });
    expect(textOf(out)).toContain(`(${e.handle})`);
    memory.close();
  });

  // A title that smuggles a line break in any form stays on its line.
  it('keeps hostile titles on their line', () => {
    const { memory, shared, task } = setup();
    const breaks = [
      '\n',
      '\r',
      '\r\n',
      '\v',
      '\f',
      '\u0085',
      '\u2028',
      '\u2029',
    ];
    breaks.forEach((br, i) =>
      saveHazard(shared, `fine${br}## Evil heading ${i}`, 'x')
    );
    const text = textOf(
      memory.promptSection({
        runId: 'r-000002',
        taskId: task.meta.id,
        dispatchTools: false,
      })
    );
    const lines = text.split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/);
    for (const line of lines.slice(1)) expect(line).not.toMatch(/^\s*#{1,6} /);
    for (const i of breaks.keys())
      expect(text).toContain(`fine ## Evil heading ${i}`);
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

  // A later import that fails its checks outranks an earlier success, now and after a restart.
  it('asks for the ledger section again once an import reports MISMATCH', () => {
    const { memory, shared, task, open } = setup();
    const ask = (m: typeof memory, runId: string) =>
      m.promptSection({ runId, taskId: task.meta.id, dispatchTools: true })
        .source;
    expect(ask(memory, 'r-000005')).toBe('memory');
    // The store miscounts its rows after the first call, as a racing writer could.
    const countEntries = shared.countEntries.bind(shared);
    let calls = 0;
    shared.countEntries = () => countEntries() + (calls++ > 0 ? 1 : 0);
    expect(memory.importLedger()?.outcome).toBe('MISMATCH');
    shared.countEntries = countEntries;
    expect(ask(memory, 'r-000006')).toBe('ledger');
    memory.close();
    const reopened = open();
    expect(ask(reopened, 'r-000007')).toBe('ledger');
    reopened.close();
  });
});
