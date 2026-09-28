import { describe, expect, it } from 'bun:test';

import { LedgerStore } from '../../src/ledger.js';
import type {
  DocsPromptPort,
  MemoryPromptPort,
} from '../../src/orchestrator/types.js';
import { makeOrchestrator, useTempProject } from '../messaging/harness.js';
import { StallingExecutor } from './helpers.js';

const project = useTempProject();
const DOCS: DocsPromptPort = {
  promptSection: () => '## Docs\n- spec · s · draft · rev 1 · 1 KB: S',
};

async function promptWith(
  port: DocsPromptPort | null,
  memory: MemoryPromptPort | null = null
): Promise<string> {
  const { orchestrator, store } = makeOrchestrator(project.root());
  const executor = new StallingExecutor();
  orchestrator.registerExecutor('claude', executor);
  orchestrator.setMemoryPort(memory);
  orchestrator.setDocsPort(port);
  const task = store.create({ title: 'Docs prompt task' });
  await orchestrator.dispatch(task.meta.id, 'claude');
  return executor.started[0].prompt;
}

describe('the ## Docs section in dispatch prompts', () => {
  it('appears after the ledger section', async () => {
    new LedgerStore(project.root()).add({
      kind: 'hazard',
      title: 'ledger lesson',
      detail: 'd',
      authoredBy: '',
    });
    const prompt = await promptWith(DOCS);
    const ledgerAt = prompt.indexOf(
      '## Findings and decisions from earlier work'
    );
    expect(ledgerAt).toBeGreaterThan(-1);
    expect(prompt.indexOf('## Docs\n- spec · s')).toBeGreaterThan(ledgerAt);
  });

  it('appears after the memory section', async () => {
    const prompt = await promptWith(DOCS, {
      promptSection: () => ({
        source: 'memory',
        text: '## Memory\n- hazard: x (#AAAAAAAA)',
      }),
    });
    const memoryAt = prompt.indexOf('## Memory\n- hazard: x');
    expect(memoryAt).toBeGreaterThan(-1);
    expect(prompt.indexOf('## Docs\n- spec · s')).toBeGreaterThan(memoryAt);
  });

  it('review focus 3: a throwing or unavailable docs service leaves the prompt intact', async () => {
    const throwing = await promptWith({
      promptSection: () => {
        throw new Error('docs.db is gone');
      },
    });
    expect(throwing).toContain('# Task ');
    expect(throwing).not.toContain('## Docs');
    expect(await promptWith({ promptSection: () => null })).not.toContain(
      '## Docs'
    );
  });
});
