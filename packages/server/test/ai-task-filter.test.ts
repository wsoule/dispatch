import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { TaskDoc } from '@dispatch/core';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type AiFilterVocabulary,
  type AiTaskFilterPort,
  buildAiFilterPrompt,
  ClaudeAiTaskFilter,
  FakeAiTaskFilter,
  sanitizeAiFilter,
} from '../src/aiTaskFilter';
import { aiFilterTasks } from '../src/api/aiFilter';

const vocab: AiFilterVocabulary = {
  statuses: ['draft', 'ready', 'working', 'review', 'landed'],
  labels: ['ui', 'api'],
  milestones: ['v1'],
  epics: [{ id: 'e-1', title: 'Payments epic' }],
  runStates: ['running', 'awaiting-approval'],
};

const NOW = new Date('2026-09-20T15:30:00.000Z');

describe('sanitizeAiFilter', () => {
  test('drops an invented facet', () => {
    const out = sanitizeAiFilter(
      { clauses: [{ facet: 'owner', op: 'is', values: ['me'] }], join: 'and' },
      vocab
    );
    expect(out.clauses).toEqual([]);
  });

  test('drops an operator the facet does not take', () => {
    const out = sanitizeAiFilter(
      {
        clauses: [
          { facet: 'priority', op: 'before', values: ['urgent'] },
          { facet: 'created', op: 'is', values: [], daysAgo: 7 },
        ],
        join: 'and',
      },
      vocab
    );
    expect(out.clauses).toEqual([]);
  });

  test('keeps only values inside the vocabulary', () => {
    const out = sanitizeAiFilter(
      {
        clauses: [
          { facet: 'status', op: 'is', values: ['working', 'shipped'] },
          { facet: 'labels', op: 'includes', values: ['ui', 'design'] },
          { facet: 'priority', op: 'is', values: ['urgent', 'p0'] },
          { facet: 'milestone', op: 'is', values: ['v2'] },
        ],
        join: 'and',
      },
      vocab
    );
    expect(out.clauses).toEqual([
      { facet: 'status', op: 'is', values: ['working'] },
      { facet: 'labels', op: 'includes', values: ['ui'] },
      { facet: 'priority', op: 'is', values: ['urgent'] },
    ]);
  });

  test('drops a clause left with no values', () => {
    const out = sanitizeAiFilter(
      { clauses: [{ facet: 'status', op: 'is', values: [] }], join: 'or' },
      vocab
    );
    expect(out).toEqual({ clauses: [], join: 'or' });
  });

  test('maps an epic title to its id, case-insensitively', () => {
    const out = sanitizeAiFilter(
      {
        clauses: [
          { facet: 'epic', op: 'is', values: ['payments EPIC', 'Search epic'] },
        ],
        join: 'and',
      },
      vocab
    );
    expect(out.clauses).toEqual([{ facet: 'epic', op: 'is', values: ['e-1'] }]);
  });

  test('keeps none for the scalar facets that have it', () => {
    const out = sanitizeAiFilter(
      {
        clauses: [
          { facet: 'epic', op: 'is', values: ['none'] },
          { facet: 'milestone', op: 'is not', values: ['none'] },
          { facet: 'run', op: 'is', values: ['none'] },
          { facet: 'assignee', op: 'is', values: ['none'] },
        ],
        join: 'and',
      },
      vocab
    );
    expect(out.clauses.map((c) => c.values)).toEqual([
      ['none'],
      ['none'],
      ['none'],
      ['none'],
    ]);
  });

  test('resolves daysAgo to midnight UTC that many days back', () => {
    const out = sanitizeAiFilter(
      {
        clauses: [
          { facet: 'created', op: 'after', values: [], daysAgo: 7 },
          { facet: 'updated', op: 'before', values: [], daysAgo: 0 },
          { facet: 'updated', op: 'after', values: [] },
        ],
        join: 'and',
      },
      vocab,
      NOW
    );
    expect(out.clauses).toEqual([
      { facet: 'created', op: 'after', values: ['2026-09-13T00:00:00.000Z'] },
      { facet: 'updated', op: 'before', values: ['2026-09-20T00:00:00.000Z'] },
    ]);
  });

  test('a malformed payload is the empty set joined by and', () => {
    expect(sanitizeAiFilter('nope', vocab)).toEqual({
      clauses: [],
      join: 'and',
    });
    expect(sanitizeAiFilter({ clauses: 'x', join: 'or' }, vocab)).toEqual({
      clauses: [],
      join: 'or',
    });
  });
});

describe('buildAiFilterPrompt', () => {
  test('lists the vocabulary and ends with the sentence', () => {
    const prompt = buildAiFilterPrompt('urgent ui work', vocab);
    expect(prompt).toContain('Statuses: draft, ready, working, review, landed');
    expect(prompt).toContain('Labels: ui, api');
    expect(prompt).toContain('e-1 — Payments epic');
    expect(prompt.endsWith('Sentence: urgent ui work')).toBe(true);
  });
});

// A stub queryFn that yields one SDK result message, recording the prompt it was given.
function stubQuery(
  message: Record<string, unknown>,
  prompts: string[] = []
): typeof import('@anthropic-ai/claude-agent-sdk').query {
  function* messages(): Generator<unknown> {
    yield message;
  }
  return ((args: { prompt: unknown }) => {
    prompts.push(String(args.prompt));
    return messages() as unknown as Query;
  }) as never;
}

describe('ClaudeAiTaskFilter', () => {
  test('returns the sanitized structured output', async () => {
    const prompts: string[] = [];
    const port = new ClaudeAiTaskFilter(
      tmpdir(),
      stubQuery(
        {
          type: 'result',
          subtype: 'success',
          session_id: 's',
          structured_output: {
            clauses: [
              { facet: 'priority', op: 'is', values: ['urgent'] },
              { facet: 'status', op: 'is', values: ['nope'] },
            ],
            join: 'and',
          },
        },
        prompts
      )
    );
    const out = await port.toFilters('urgent tasks', vocab);
    expect(out).toEqual({
      clauses: [{ facet: 'priority', op: 'is', values: ['urgent'] }],
      join: 'and',
    });
    expect(prompts[0]).toContain('Sentence: urgent tasks');
  });

  // `allowedTools: []` looked like "no tools" but only skipped approval: the
  // call still loaded every built-in plus the operator's MCP connectors.
  test('offers the model no built-in or operator MCP tools', async () => {
    let options: Record<string, unknown> = {};
    const port = new ClaudeAiTaskFilter(tmpdir(), ((args: {
      options: Record<string, unknown>;
    }) => {
      options = args.options;
      return stubQuery({
        type: 'result',
        subtype: 'success',
        session_id: 's',
        structured_output: { clauses: [], join: 'and' },
      })(args as never);
    }) as never);
    await port.toFilters('anything', vocab);
    expect(options.tools).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.mcpServers).toBeUndefined();
  });

  test('a non-success result throws', async () => {
    const port = new ClaudeAiTaskFilter(
      tmpdir(),
      stubQuery({ type: 'result', subtype: 'error_max_turns', session_id: 's' })
    );
    await expect(port.toFilters('anything', vocab)).rejects.toThrow(
      'ai filter failed: error_max_turns'
    );
  });
});

describe('FakeAiTaskFilter', () => {
  test('urgent tasks nobody is on', async () => {
    const out = await new FakeAiTaskFilter().toFilters(
      'urgent tasks nobody is on',
      vocab
    );
    expect(out).toEqual({
      clauses: [
        { facet: 'priority', op: 'is', values: ['urgent'] },
        { facet: 'assignee', op: 'is', values: ['none'] },
      ],
      join: 'and',
    });
  });

  test('statuses, labels, live runs and or', async () => {
    const out = await new FakeAiTaskFilter().toFilters(
      'Working or review ui tasks that are running',
      vocab
    );
    expect(out).toEqual({
      clauses: [
        { facet: 'status', op: 'is', values: ['working', 'review'] },
        { facet: 'run', op: 'is', values: ['running'] },
        { facet: 'labels', op: 'includes', values: ['ui'] },
      ],
      join: 'or',
    });
  });

  test('no keyword, no clauses', async () => {
    const out = await new FakeAiTaskFilter().toFilters('hello there', vocab);
    expect(out).toEqual({ clauses: [], join: 'and' });
  });
});

function doc(over: Partial<TaskDoc['meta']>): TaskDoc {
  return {
    meta: {
      id: 't-1',
      title: 'A task',
      status: 'ready',
      kind: 'task',
      parent: null,
      milestone: null,
      labels: [],
      ...over,
    },
    body: '',
  } as unknown as TaskDoc;
}

function routeContext(port: AiTaskFilterPort = new FakeAiTaskFilter()) {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-ai-filter-'));
  mkdirSync(join(root, '.dispatch'));
  writeFileSync(
    join(root, '.dispatch', 'config.yml'),
    'statuses:\n  - ready\n  - doing\n  - landed\n'
  );
  const docs = [
    doc({ id: 'e-1', title: 'Payments epic', kind: 'epic' }),
    doc({ id: 't-2', labels: ['ui'], milestone: 'v1', parent: 'e-1' }),
  ];
  return {
    rootDir: root,
    cache: { query: () => docs },
    aiTaskFilter: port,
  };
}

function post(body: unknown, contentType = 'application/json'): Request {
  return new Request('http://localhost/api/tasks/ai-filter', {
    method: 'POST',
    headers: contentType === '' ? {} : { 'content-type': contentType },
    body: JSON.stringify(body),
  });
}

describe('aiFilterTasks', () => {
  test('answers the clauses from the project vocabulary', async () => {
    const seen: AiFilterVocabulary[] = [];
    const port: AiTaskFilterPort = {
      toFilters: async (sentence, v) => {
        seen.push(v);
        return new FakeAiTaskFilter().toFilters(sentence, v);
      },
    };
    const res = await aiFilterTasks(
      post({ sentence: 'urgent doing ui tasks nobody is on' }),
      routeContext(port)
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      clauses: [
        { facet: 'priority', op: 'is', values: ['urgent'] },
        { facet: 'assignee', op: 'is', values: ['none'] },
        { facet: 'status', op: 'is', values: ['doing'] },
        { facet: 'labels', op: 'includes', values: ['ui'] },
      ],
      join: 'and',
    });
    expect(seen[0]).toEqual({
      statuses: ['ready', 'doing', 'landed'],
      labels: ['ui'],
      milestones: ['v1'],
      epics: [{ id: 'e-1', title: 'Payments epic' }],
      runStates: [
        'provisioning',
        'running',
        'awaiting-approval',
        'finished',
        'failed',
        'cancelled',
        'interrupted-dirty',
      ],
    });
  });

  test('400 when the sentence is longer than a menu line', async () => {
    const res = await aiFilterTasks(
      post({ sentence: 'urgent '.repeat(100) }),
      routeContext()
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'sentence is too long' });
  });

  test('400 without a sentence', async () => {
    const res = await aiFilterTasks(post({}), routeContext());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'sentence is required' });
  });

  test('415 without the JSON content type', async () => {
    const res = await aiFilterTasks(
      post({ sentence: 'urgent' }, ''),
      routeContext()
    );
    expect(res.status).toBe(415);
  });

  test('502 when the port throws', async () => {
    const res = await aiFilterTasks(
      post({ sentence: 'urgent' }),
      routeContext({
        toFilters: () => Promise.reject(new Error('model unavailable')),
      })
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'model unavailable' });
  });
});
