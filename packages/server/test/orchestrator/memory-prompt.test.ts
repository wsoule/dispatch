import { describe, expect, it } from 'bun:test';

import { LedgerStore } from '../../src/ledger.js';
import { EXPORT_PROMPT_LINE } from '../../src/memory/claudeModes.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { transcriptPath } from '../../src/orchestrator/paths.js';
import { RepoDigestCache } from '../../src/orchestrator/repoDigest.js';
import { replayTranscript } from '../../src/orchestrator/transcript.js';
import { DEFAULT_EXECUTOR_PROFILE } from '../../src/orchestrator/types.js';
import type {
  ExecutorEvents,
  ExecutorRun,
  ExecutorStartOptions,
  MemoryPromptPort,
  PreparedMemory,
} from '../../src/orchestrator/types.js';
import {
  makeOrchestrator,
  useTempProject,
  waitFor,
} from '../messaging/harness.js';
import { StallingExecutor } from './helpers.js';

const project = useTempProject();

const SECTION = '## Memory\n- hazard: from port (#AAAAAAAA)';
const DIR = '/h/.dispatch/runs/k/claude-memory/r-1';

type PrepareInput = Parameters<MemoryPromptPort['prepare']>[0];

// A port that records every call and answers prepare with `answer`.
function recordingPort(
  answer: (input: PrepareInput) => PreparedMemory = () => ({
    text: null,
    indexSection: null,
    memory: { mode: 'prompt' },
  })
) {
  const calls: PrepareInput[] = [];
  const recalls: unknown[][] = [];
  const ended: string[] = [];
  const port: MemoryPromptPort = {
    prepare: (input) => {
      calls.push(input);
      return answer(input);
    },
    recall: (...args) => recalls.push(args),
    runEnded: (meta) => ended.push(meta.id),
  };
  return { calls, recalls, ended, port };
}

// An orchestrator with a stalling 'claude' executor and `port` as its memory.
function withPort(
  port: MemoryPromptPort,
  extra: Parameters<typeof makeOrchestrator>[1] = {}
) {
  const { orchestrator, store } = makeOrchestrator(project.root(), extra);
  const executor = new StallingExecutor();
  orchestrator.registerExecutor('claude', executor);
  orchestrator.setMemoryPort(port);
  return { orchestrator, store, executor };
}

// A stalling executor whose runs never get the dispatch MCP server.
class NoToolsExecutor extends StallingExecutor {
  readonly profile = { ...DEFAULT_EXECUTOR_PROFILE, dispatchMcp: false };
}

// A stalling executor that honours Claude auto memory and keeps each run's events.
class AutoMemoryExecutor extends StallingExecutor {
  readonly profile = { ...DEFAULT_EXECUTOR_PROFILE, autoMemory: true };
  readonly events: ExecutorEvents[] = [];

  override start(
    opts: ExecutorStartOptions,
    events: ExecutorEvents
  ): ExecutorRun {
    this.events.push(events);
    return super.start(opts, events);
  }
}

// A scripted executor that honours Claude auto memory and records each start.
class AutoMemoryFake extends FakeExecutor {
  readonly profile = { ...DEFAULT_EXECUTOR_PROFILE, autoMemory: true };
  readonly started: ExecutorStartOptions[] = [];

  override start(opts: ExecutorStartOptions, events: ExecutorEvents) {
    this.started.push(opts);
    return super.start(opts, events);
  }
}

// A repo-map cache that counts how often a prompt's orientation read it.
class CountingDigestCache extends RepoDigestCache {
  reads = 0;

  override current() {
    this.reads += 1;
    return super.current();
  }
}

const exportAnswer = (): PreparedMemory => ({
  text: EXPORT_PROMPT_LINE,
  indexSection: SECTION,
  memory: {
    mode: 'export',
    dir: DIR,
    probeVersion: '2.1.207',
    unloadedNote: 'UNLOADED NOTE',
  },
});

describe('dispatch prompt memory', () => {
  it('asks the port once with the new run, its lineage and kind, and uses its section', async () => {
    const { calls, port } = recordingPort(() => ({
      text: SECTION,
      indexSection: SECTION,
      memory: { mode: 'prompt' },
    }));
    const t = withPort(port);
    const task = t.store.create({ title: 'Bump pnpm' });
    const meta = await t.orchestrator.dispatch(task.meta.id, 'claude');
    expect(calls).toEqual([
      {
        runId: meta.id,
        taskId: task.meta.id,
        lineage: meta.id,
        runKind: 'execute',
        isClaude: false,
        dispatchTools: true,
      },
    ]);
    const started = t.executor.started.at(-1);
    expect(started?.prompt).toContain('from port');
    expect(started?.prompt).not.toContain('## Findings and decisions');
    expect(started?.memory).toEqual({ mode: 'prompt' });
    expect(meta.memoryMode).toBe('prompt');
    await t.orchestrator.cancel(meta.id);
  });

  it('tells the port when the executor has no dispatch tools', async () => {
    const { calls, port } = recordingPort();
    const t = withPort(port);
    t.orchestrator.registerExecutor('cli', new NoToolsExecutor());
    const task = t.store.create({ title: 'no tools' });
    const meta = await t.orchestrator.dispatch(task.meta.id, 'cli');
    expect(calls.map((c) => c.dispatchTools)).toEqual([false]);
    await t.orchestrator.cancel(meta.id);
  });

  it('export: the prompt carries the export line, the fallback prompt the index, and the header the mode', async () => {
    const { calls, port } = recordingPort(exportAnswer);
    const t = withPort(port);
    const executor = new AutoMemoryExecutor();
    t.orchestrator.registerExecutor('claude', executor);
    const task = t.store.create({ title: 'Bump pnpm' });
    const meta = await t.orchestrator.dispatch(task.meta.id, 'claude');
    expect(calls[0].isClaude).toBe(true);
    const started = executor.started[0];
    expect(started.prompt).toContain(EXPORT_PROMPT_LINE);
    expect(started.prompt).not.toContain('## Memory');
    expect(started.memory).toMatchObject({
      mode: 'export',
      dir: DIR,
      probeVersion: '2.1.207',
      unloadedNote: 'UNLOADED NOTE',
    });
    expect(started.memory?.fallbackPrompt).toContain('from port');
    expect(started.memory?.fallbackPrompt).toContain('Bump pnpm');
    expect(started.memory?.fallbackPrompt).not.toContain(EXPORT_PROMPT_LINE);
    expect(meta.memoryMode).toBe('export');
    expect(
      replayTranscript(transcriptPath(project.root(), meta.id))?.meta.memoryMode
    ).toBe('export');
    await t.orchestrator.cancel(meta.id);
  });

  it.each(['export-fallback', 'export-unloaded'] as const)(
    'records %s on a state line and in the Session log',
    async (mode) => {
      const { port } = recordingPort(exportAnswer);
      const t = withPort(port);
      const executor = new AutoMemoryExecutor();
      t.orchestrator.registerExecutor('claude', executor);
      const task = t.store.create({ title: 'Bump pnpm' });
      const meta = await t.orchestrator.dispatch(task.meta.id, 'claude');
      const detail = `Claude Code 2.1.210 moved this run to ${mode}`;
      executor.events[0].onMemoryMode?.(mode, detail);
      expect(t.orchestrator.getRun(meta.id)?.meta.memoryMode).toBe(mode);
      const replayed = replayTranscript(
        transcriptPath(project.root(), meta.id)
      );
      expect(replayed?.meta.memoryMode).toBe(mode);
      expect(
        replayed?.entries.some(
          (e) => e.kind === 'system' && e.text?.includes(detail) === true
        )
      ).toBe(true);
      await t.orchestrator.cancel(meta.id);
    }
  );

  it('forwards recalls with the run’s lineage and tells the port when the run ends', async () => {
    const { recalls, ended, port } = recordingPort(exportAnswer);
    const t = withPort(port);
    const executor = new AutoMemoryExecutor();
    t.orchestrator.registerExecutor('claude', executor);
    const task = t.store.create({ title: 'recalls' });
    const meta = await t.orchestrator.dispatch(task.meta.id, 'claude');
    executor.events[0].onMemoryRecall?.([`${DIR}/mem-1.md`], 'claude-recall');
    expect(recalls).toEqual([
      [meta.id, meta.id, [`${DIR}/mem-1.md`], 'claude-recall'],
    ]);
    await t.orchestrator.cancel(meta.id);
    await waitFor(() => ended.includes(meta.id));
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
    expect(calls.map((c) => [c.runId, c.lineage])).toEqual([
      [failed.id, failed.id],
      [resumed.id, resumed.id],
    ]);
    await waitFor(() => stateOf(resumed.id) === 'failed');
  });

  // A failed load check restarts a continuing session fresh, so it needs the task prompt.
  it('gives continuing resumes in export mode the task prompt with the index as their fallback', async () => {
    const { calls, port } = recordingPort(exportAnswer);
    const t = withPort(port);
    const executor = new AutoMemoryFake({
      session: 's-1',
      finish: { state: 'failed', error: 'boom', sessionId: 's-1' },
    });
    t.orchestrator.registerExecutor('claude', executor);
    const task = t.store.create({ title: 'Bump pnpm' });
    const first = await t.orchestrator.dispatch(task.meta.id, 'claude');
    const stateOf = (id: string) => t.orchestrator.getRun(id)?.meta.state;
    await waitFor(() => stateOf(first.id) === 'failed');
    const resumed = t.orchestrator.resumeRun(first.id);
    await waitFor(() => stateOf(resumed.id) === 'failed');
    const changed = t.orchestrator.sendMessage(resumed.id, 'also bump bun', {
      resume: true,
    });
    await waitFor(() => stateOf(changed.id) === 'failed');
    expect(calls.map((c) => c.lineage)).toEqual([first.id, first.id, first.id]);
    for (const started of executor.started.slice(1)) {
      expect(started.resumeSessionId).toBe('s-1');
      expect(started.prompt).not.toContain('## Memory');
      expect(started.memory?.fallbackPrompt).toContain('from port');
      expect(started.memory?.fallbackPrompt).toContain('Bump pnpm');
    }
    expect(executor.started[2].prompt).toBe('also bump bun');
  });

  // The ledger never reaches a prompt: a broken port costs only the section.
  it('drops the memory section when the port throws, and still dispatches with auto memory off', async () => {
    new LedgerStore(project.root()).add({
      kind: 'hazard',
      title: 'ledger lesson',
      detail: 'd',
      authoredBy: '',
    });
    const t = withPort({
      prepare: () => {
        throw new Error('memory broke');
      },
      recall: () => {},
      runEnded: () => {},
    });
    const task = t.store.create({ title: 'still runs' });
    const meta = await t.orchestrator.dispatch(task.meta.id, 'claude');
    expect(meta.state).toBe('running');
    const started = t.executor.started.at(-1);
    expect(started?.prompt).not.toContain('## Memory');
    expect(started?.prompt).not.toContain('ledger lesson');
    expect(started?.memory).toEqual({ mode: 'prompt' });
    await t.orchestrator.cancel(meta.id);
  });

  // Only the memory service may choose native, so a run before it is installed gets prompt.
  it('starts an auto-memory run with auto memory off when no port is installed', async () => {
    const { orchestrator, store } = makeOrchestrator(project.root());
    const executor = new AutoMemoryExecutor();
    orchestrator.registerExecutor('claude', executor);
    const task = store.create({ title: 'no port yet' });
    const meta = await orchestrator.dispatch(task.meta.id, 'claude');
    expect(executor.started[0].memory).toEqual({ mode: 'prompt' });
    expect(meta.memoryMode).toBe('prompt');
    await orchestrator.cancel(meta.id);
  });

  it('reads the orientation once for an export run’s prompt and its fallback', async () => {
    const digestCache = new CountingDigestCache(project.root());
    const t = withPort(recordingPort(exportAnswer).port, { digestCache });
    t.orchestrator.registerExecutor('claude', new AutoMemoryExecutor());
    const task = t.store.create({ title: 'Bump pnpm' });
    const meta = await t.orchestrator.dispatch(task.meta.id, 'claude');
    expect(digestCache.reads).toBe(1);
    await t.orchestrator.cancel(meta.id);
  });

  // The fallback is best effort: a brief that will not build must not strand the run.
  it('starts a continuing export resume without a fallback when its brief will not build', async () => {
    const t = withPort(recordingPort(exportAnswer).port);
    const executor = new AutoMemoryFake({
      session: 's-1',
      finish: { state: 'failed', error: 'boom', sessionId: 's-1' },
    });
    t.orchestrator.registerExecutor('claude', executor);
    const epic = t.store.create({ title: 'Toolchain' });
    const task = t.store.create({ title: 'Bump pnpm', parent: epic.meta.id });
    const first = await t.orchestrator.dispatch(task.meta.id, 'claude');
    const stateOf = (id: string) => t.orchestrator.getRun(id)?.meta.state;
    await waitFor(() => stateOf(first.id) === 'failed');
    const get = t.store.get.bind(t.store);
    t.store.get = (id) => {
      if (id === epic.meta.id) throw new Error('EIO: epic unreadable');
      return get(id);
    };
    const resumed = t.orchestrator.resumeRun(first.id);
    await waitFor(() => stateOf(resumed.id) === 'failed');
    expect(executor.started[1].memory).toMatchObject({ mode: 'export' });
    expect(executor.started[1].memory?.fallbackPrompt).toBeUndefined();
  });
});

describe('aux run memory', () => {
  it('gives a review run the port’s mode, and a fix-loop implementer the export and its fallback', async () => {
    const { calls, port } = recordingPort((input) =>
      input.runKind === 'review'
        ? { text: null, indexSection: null, memory: { mode: 'prompt' } }
        : exportAnswer()
    );
    const t = withPort(port);
    const executor = new AutoMemoryExecutor();
    t.orchestrator.registerExecutor('claude', executor);
    const task = t.store.create({ title: 'aux' });
    const aux = (kind: 'review' | 'execute', prompt: string) =>
      t.orchestrator.dispatchAuxRun({
        taskId: task.meta.id,
        kind,
        head: 'main',
        buildPrompt: () => prompt,
      });
    const review = await aux('review', 'REVIEW THIS');
    expect(executor.started[0].prompt).toBe('REVIEW THIS');
    expect(executor.started[0].memory).toEqual({ mode: 'prompt' });
    expect(review.memoryMode).toBe('prompt');
    await t.orchestrator.cancel(review.id);

    const fix = await aux('execute', 'FIX THIS');
    expect(executor.started[1].prompt).toBe(
      `FIX THIS\n\n${EXPORT_PROMPT_LINE}`
    );
    expect(executor.started[1].memory).toMatchObject({
      mode: 'export',
      dir: DIR,
      fallbackPrompt: `FIX THIS\n\n${SECTION}`,
    });
    expect(calls.map((c) => c.runKind)).toEqual(['review', 'execute']);
    await t.orchestrator.cancel(fix.id);
  });

  // The port started following the run's export, so a failed start must end it.
  it('ends the run’s memory when its prompt cannot be built', () => {
    const { ended, port } = recordingPort(exportAnswer);
    const t = withPort(port);
    const task = t.store.create({ title: 'fix loop' });
    expect(() =>
      t.orchestrator.dispatchAuxRun({
        taskId: task.meta.id,
        kind: 'execute',
        head: 'main',
        buildPrompt: () => {
          throw new Error('no diff to fix');
        },
      })
    ).toThrow('no diff to fix');
    const runs = t.orchestrator.list().filter((r) => r.taskId === task.meta.id);
    expect(runs.map((r) => r.state)).toEqual(['failed']);
    expect(ended).toEqual(runs.map((r) => r.id));
  });
});
