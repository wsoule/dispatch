import type { TaskDoc } from '@dispatch/core';
import { defaultTaskFields } from '@dispatch/core';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JudgmentClient } from '../../src/judgments/client';
import {
  checklistQuestions,
  checklistState,
  checklistSummary,
  computeChecklist,
  extractRequirements,
  interpretChecklist,
  readChecklist,
} from '../../src/judgments/landingChecklist';
import type { RunMeta } from '../../src/orchestrator/types';

function task(title: string, body: string): TaskDoc {
  return {
    meta: {
      id: 't-000001',
      title,
      status: 'review',
      kind: 'task',
      parent: null,
      milestone: null,
      blockedBy: [],
      labels: [],
      priority: 'medium',
      assignee: 'none',
      risk: 'routine',
      model: null,
      selfReview: true,
      writes: [],
      external: null,
      exercised: false,
      ...defaultTaskFields(),
      created: '2026-09-01T00:00:00.000Z',
      updated: '2026-09-01T00:00:00.000Z',
    },
    body,
  };
}

function meta(): RunMeta {
  return {
    id: 'r-000001',
    taskId: 't-000001',
    taskTitle: 'x',
    executor: 'fake',
    state: 'finished',
    branch: 'dispatch/r-000001',
    baseBranch: 'main',
    worktreePath: '/tmp/none',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

const diff = {
  patch: 'diff --git a/src/a.ts b/src/a.ts\n+export const a = 1;\n',
  files: [{ path: 'src/a.ts', status: 'M' }],
};

describe('extractRequirements', () => {
  test('prefers checkbox lines wherever they are', () => {
    const body =
      '## Description\n\nStuff\n\n- [ ] first\n- [x] second\n\n## Acceptance Criteria\n\n- ignored bullet\n';
    expect(extractRequirements(body, 'T')).toEqual(['first', 'second']);
  });

  test('falls back to the Acceptance Criteria section bullets', () => {
    const body =
      '## Description\n\n- not this\n\n## Acceptance Criteria\n\n- crit one\n* crit two\n\n## Activity\n';
    expect(extractRequirements(body, 'T')).toEqual(['crit one', 'crit two']);
  });

  test('then to every bullet in the body, then to the title', () => {
    expect(extractRequirements('## Description\n\n- a\n- b\n', 'T')).toEqual([
      'a',
      'b',
    ]);
    expect(
      extractRequirements('## Description\n\nprose only\n', 'The title')
    ).toEqual(['The title']);
  });

  test('caps the list at twelve', () => {
    const body = Array.from({ length: 20 }, (_, i) => `- [ ] r${i}`).join('\n');
    expect(extractRequirements(body, 'T')).toHaveLength(12);
  });
});

describe('checklistQuestions / checklistState', () => {
  test('asks one noul per requirement plus scope creep', () => {
    const q = checklistQuestions(['a', 'b']);
    expect(Object.keys(q)).toEqual(['req_0', 'req_1', 'scope_creep']);
    expect(q.req_0.type).toBe('noul');
  });

  test('state carries the requirements and the diff files', () => {
    const state = checklistState(task('T', ''), ['a'], diff) as {
      task: { title: string; requirements: string[] };
      diff: { files: string[]; patch: string };
    };
    expect(state.task.requirements).toEqual(['a']);
    expect(state.diff.files).toEqual(['src/a.ts']);
    expect(state.diff.patch).toContain('export const a');
  });
});

describe('interpretChecklist', () => {
  test('applies the pass and weak thresholds', () => {
    const got = interpretChecklist(
      'r-1',
      't-1',
      ['a', 'b', 'c'],
      {
        req_0: { type: 'noul', noul: 0.9 },
        req_1: { type: 'noul', noul: 0.6 },
        req_2: { type: 'noul', noul: 0.2 },
        scope_creep: { type: 'noul', noul: 0.3 },
      },
      'now'
    );
    expect(got.passed).toBe(1);
    expect(got.total).toBe(3);
    expect(got.weak).toEqual(['c']);
    expect(got.scopeCreep).toBe(0.3);
    expect(got.items.map((i) => i.probability)).toEqual([0.9, 0.6, 0.2]);
    expect(checklistSummary(got)).toEqual({ passed: 1, total: 3, weak: ['c'] });
  });
});

describe('computeChecklist / readChecklist', () => {
  test('writes the checklist under the run dir and reads it back', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dispatch-checklist-home-'));
    const original = process.env.DISPATCH_HOME;
    process.env.DISPATCH_HOME = home;
    try {
      const client: JudgmentClient = {
        model: 'jev-test',
        judge: () =>
          Promise.resolve({
            model: 'jev-test',
            answers: {
              req_0: { type: 'noul', noul: 0.8 },
              scope_creep: { type: 'noul', noul: 0.1 },
            },
            usage: { input_tokens: 1, output_tokens: 0 },
          } as never),
      };
      const root = '/tmp/dispatch-checklist-root';
      expect(readChecklist(root, 'r-000001')).toBeNull();
      const got = await computeChecklist(
        client,
        root,
        meta(),
        task('Do a', '- [ ] a'),
        diff
      );
      expect(got?.passed).toBe(1);
      expect(readChecklist(root, 'r-000001')).toEqual(got);
    } finally {
      if (original === undefined) delete process.env.DISPATCH_HOME;
      else process.env.DISPATCH_HOME = original;
    }
  });

  test('returns null with no client or a failing one', async () => {
    expect(
      await computeChecklist(null, '/tmp/x', meta(), task('T', ''), diff)
    ).toBeNull();
    const failing: JudgmentClient = {
      model: 'jev-test',
      judge: () => Promise.reject(new Error('down')),
    };
    expect(
      await computeChecklist(failing, '/tmp/x', meta(), task('T', ''), diff)
    ).toBeNull();
  });
});
