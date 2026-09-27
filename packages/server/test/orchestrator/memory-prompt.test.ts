import { describe, expect, it } from 'bun:test';

import { LedgerStore } from '../../src/ledger.js';
import type {
  MemoryPromptPort,
  MemoryPromptSection,
} from '../../src/orchestrator/types.js';
import { makeOrchestrator, useTempProject } from '../messaging/harness.js';
import { StallingExecutor } from './helpers.js';

const project = useTempProject();

// An orchestrator with a stalling 'claude' executor and `port` as its memory.
function withPort(port: MemoryPromptPort) {
  const { orchestrator, store } = makeOrchestrator(project.root());
  const executor = new StallingExecutor();
  orchestrator.registerExecutor('claude', executor);
  orchestrator.setMemoryPort(port);
  return { orchestrator, store, executor };
}

function addLedgerLesson(): void {
  new LedgerStore(project.root()).add({
    kind: 'hazard',
    title: 'ledger lesson',
    detail: 'd',
    authoredBy: '',
  });
}

describe('dispatch prompt memory', () => {
  it('asks the port with the new run and its task, and uses its section', async () => {
    const calls: unknown[] = [];
    const t = withPort({
      promptSection: (input): MemoryPromptSection => {
        calls.push(input);
        return {
          source: 'memory',
          text: '## Memory\n- hazard: from port (#AAAAAAAA)',
        };
      },
    });
    const task = t.store.create({ title: 'Bump pnpm' });
    const meta = await t.orchestrator.dispatch(task.meta.id, 'claude');
    expect(calls).toEqual([
      { runId: meta.id, taskId: task.meta.id, dispatchTools: true },
    ]);
    expect(t.executor.started.at(-1)?.prompt).toContain('from port');
    expect(t.executor.started.at(-1)?.prompt).not.toContain(
      '## Findings and decisions'
    );
    await t.orchestrator.cancel(meta.id);
  });

  // Until an import succeeds, prompts keep the ledger section.
  it('falls back to the ledger section while the port says so', async () => {
    addLedgerLesson();
    const t = withPort({ promptSection: () => ({ source: 'ledger' }) });
    const task = t.store.create({ title: 'fallback' });
    const meta = await t.orchestrator.dispatch(task.meta.id, 'claude');
    expect(t.executor.started.at(-1)?.prompt).toContain(
      '## Findings and decisions from earlier work'
    );
    expect(t.executor.started.at(-1)?.prompt).toContain('ledger lesson');
    await t.orchestrator.cancel(meta.id);
  });

  it('falls back to the ledger section when the port throws, and still dispatches', async () => {
    addLedgerLesson();
    const t = withPort({
      promptSection: () => {
        throw new Error('memory broke');
      },
    });
    const task = t.store.create({ title: 'still runs' });
    const meta = await t.orchestrator.dispatch(task.meta.id, 'claude');
    expect(meta.state).toBe('running');
    expect(t.executor.started.at(-1)?.prompt).toContain('ledger lesson');
    await t.orchestrator.cancel(meta.id);
  });
});
