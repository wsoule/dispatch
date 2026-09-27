import { describe, expect, it } from 'bun:test';

import { LedgerStore } from '../../src/ledger.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { DEFAULT_EXECUTOR_PROFILE } from '../../src/orchestrator/types.js';
import type {
  MemoryPromptPort,
  MemoryPromptSection,
} from '../../src/orchestrator/types.js';
import {
  makeOrchestrator,
  useTempProject,
  waitFor,
} from '../messaging/harness.js';
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

// A stalling executor whose runs never get the dispatch MCP server.
class NoToolsExecutor extends StallingExecutor {
  readonly profile = { ...DEFAULT_EXECUTOR_PROFILE, dispatchMcp: false };
}

// A port that records every request and always asks for the ledger section.
function recordingPort() {
  const calls: Parameters<MemoryPromptPort['promptSection']>[0][] = [];
  const port: MemoryPromptPort = {
    promptSection: (input) => {
      calls.push(input);
      return { source: 'ledger' };
    },
  };
  return { calls, port };
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

  it('tells the port when the executor has no dispatch tools', async () => {
    const { calls, port } = recordingPort();
    const t = withPort(port);
    t.orchestrator.registerExecutor('cli', new NoToolsExecutor());
    const task = t.store.create({ title: 'no tools' });
    const meta = await t.orchestrator.dispatch(task.meta.id, 'cli');
    expect(calls).toEqual([
      { runId: meta.id, taskId: task.meta.id, dispatchTools: false },
    ]);
    await t.orchestrator.cancel(meta.id);
  });

  // The successor's index recalls belong to it, not to the run that died.
  it('asks the port with the new run when a resume starts a fresh session', async () => {
    const { calls, port } = recordingPort();
    const t = withPort(port);
    t.orchestrator.registerExecutor(
      'claude',
      new FakeExecutor({ finish: { state: 'failed', error: 'boom' } })
    );
    const task = t.store.create({ title: 'fresh resume' });
    const failed = await t.orchestrator.dispatch(task.meta.id, 'claude');
    const stateOf = (id: string) => t.orchestrator.getRun(id)?.meta.state;
    await waitFor(() => stateOf(failed.id) === 'failed');
    const resumed = t.orchestrator.resumeRun(failed.id);
    expect(resumed.sessionId).toBeUndefined();
    expect(calls.map((c) => c.runId)).toEqual([failed.id, resumed.id]);
    await waitFor(() => stateOf(resumed.id) === 'failed');
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
