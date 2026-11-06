import { describe, expect, test } from 'bun:test';

import { milestonesToMermaid, tasksToMermaid } from './mermaidExport';

describe('milestonesToMermaid', () => {
  test('a left-to-right flowchart with counted edges', () => {
    expect(
      milestonesToMermaid(
        [
          { id: 'e-1', title: 'M1 · Checkout', done: 1, total: 6 },
          { id: 'e-2', title: 'M2 "Auth"', done: 2, total: 7 },
        ],
        [{ from: 'e-1', to: 'e-2', count: 3 }]
      )
    ).toBe(
      [
        'flowchart LR',
        '  e_1["M1 · Checkout<br/>1/6 landed"]',
        '  e_2["M2 #quot;Auth#quot;<br/>2/7 landed"]',
        '  e_1 -->|3| e_2',
      ].join('\n')
    );
  });
});

describe('tasksToMermaid', () => {
  test('one subgraph per milestone and every wait between tasks', () => {
    expect(
      tasksToMermaid([
        {
          id: 'e-1',
          title: 'M1',
          tasks: [
            { id: 't-1', title: 'First', blockedBy: [] },
            { id: 't-2', title: 'Second', blockedBy: ['t-1'] },
          ],
        },
        {
          id: 'e-2',
          title: 'M2',
          tasks: [{ id: 't-3', title: 'Third', blockedBy: ['t-2', 't-gone'] }],
        },
      ])
    ).toBe(
      [
        'flowchart LR',
        '  subgraph e_1["M1"]',
        '    t_1["t-1 First"]',
        '    t_2["t-2 Second"]',
        '  end',
        '  subgraph e_2["M2"]',
        '    t_3["t-3 Third"]',
        '  end',
        '  t_1 --> t_2',
        '  t_2 --> t_3',
      ].join('\n')
    );
  });
});
