import { Task } from '@a2a-js/sdk';
import { describe, expect, it } from 'bun:test';

import { decideState, project, projectionKey } from '../src/projection.js';
import { ENVELOPE_URI, GATE_URI, WORK_URI } from '../src/uris.js';
import { CLIENT, facts, msg, ROOT } from './facts.js';

const answer = msg({
  id: 'm-ans',
  replyTo: 'm-root',
  from: 'human:wyat',
  to: [CLIENT],
  kind: 'answer',
  body: 'Yes, final.',
  choice: 'yes',
});
const close = (reason: string) =>
  msg({
    id: 'm-close',
    replyTo: 'm-root',
    from: 'agent:dispatch',
    to: [CLIENT],
    kind: 'answer',
    body: `Closed: ${reason}`,
    data: { type: 'x-closed', reason },
  });
const handoffTask = (status: string, approved = true) => ({
  id: 't-a1b2c3',
  title: 'Rate-limit uploads',
  status,
  approved,
});
const view = {
  client: CLIENT,
  extensions: new Set<never>(),
  textMediaType: 'text/markdown' as const,
  historyLength: null,
  includeArtifacts: true,
};

describe('decideState — one test per row of spec:400-413', () => {
  it.each([
    [
      '1 canceled',
      facts({
        canceledAt: '2026-09-25T11:00:00.000Z',
        answer: close('canceled by client'),
      }),
      1,
      'CANCELED',
    ],
    [
      '2 ask declined by the owner',
      facts({
        declinedAt: '2026-09-25T11:00:00.000Z',
        answer: close('declined'),
      }),
      2,
      'REJECTED',
    ],
    [
      '2 handoff proposal declined',
      facts({
        skill: 'handoff',
        task: handoffTask('dropped', false),
        answer: msg({
          from: 'agent:dispatch',
          kind: 'answer',
          choice: 'decline',
          replyTo: 'm-root',
        }),
      }),
      2,
      'REJECTED',
    ],
    [
      '2 handoff dropped by someone else',
      facts({
        skill: 'handoff',
        task: handoffTask('dropped'),
        dropped: 'other',
      }),
      2,
      'REJECTED',
    ],
    [
      '3 closed by the system',
      facts({ answer: close('client revoked') }),
      3,
      'FAILED',
    ],
    [
      '3 recipient task dropped',
      facts({ recipientTaskDropped: true }),
      3,
      'FAILED',
    ],
    [
      '4 linked task deleted',
      facts({ skill: 'handoff', task: 'deleted' }),
      4,
      'FAILED',
    ],
    ['5 answered', facts({ answer }), 5, 'COMPLETED'],
    [
      '6 landed',
      facts({ skill: 'handoff', task: handoffTask('landed') }),
      6,
      'COMPLETED',
    ],
    [
      '7 blocking question to the client',
      facts({
        openQuestions: [
          msg({
            id: 'm-q',
            kind: 'question',
            blocking: true,
            replyTo: 'm-root',
          }),
        ],
      }),
      7,
      'INPUT_REQUIRED',
    ],
    [
      '8 open gate',
      facts({
        skill: 'handoff',
        task: handoffTask('draft', false),
        openGates: [
          { id: 'm-g', type: 'task-proposal', openedAt: ROOT.createdAt },
        ],
      }),
      8,
      'AUTH_REQUIRED',
    ],
    [
      '9 working',
      facts({ skill: 'handoff', task: handoffTask('working') }),
      9,
      'WORKING',
    ],
    [
      '9 custom status',
      facts({ skill: 'handoff', task: handoffTask('qa') }),
      9,
      'WORKING',
    ],
    [
      '10 approved, not yet scheduled',
      facts({ skill: 'handoff', task: handoffTask('ready') }),
      10,
      'SUBMITTED',
    ],
    [
      '11 held in a mailbox',
      facts({
        root: { ...ROOT, to: ['task:t-a1b2c3'] },
        rootDeliveries: ['held'],
      }),
      11,
      'SUBMITTED',
    ],
    ['12 otherwise', facts(), 12, 'WORKING'],
  ])('row %s', (_name, f, row, state) => {
    expect(decideState(f)).toMatchObject({ row, state });
  });

  it('never lets a gate-bearing question make INPUT_REQUIRED (row 7 skips it)', () => {
    const gateQ = msg({
      id: 'm-gq',
      kind: 'question',
      blocking: true,
      data: { type: 'wake', target: 'task:t-1', message: 'm' },
    });
    expect(decideState(facts({ openQuestions: [gateQ] })).state).toBe(
      'WORKING'
    );
  });

  it('skips a question with gate data of an unknown type, or one answering a gate, for row 7', () => {
    const future = msg({
      id: 'm-fq',
      kind: 'question',
      blocking: true,
      data: { type: 'future-gate' },
    });
    const gate = msg({
      id: 'm-g7',
      replyTo: 'm-root',
      from: 'agent:dispatch',
      kind: 'question',
      data: { type: 'wake', target: 'task:t-1', message: 'm' },
    });
    const followUp = msg({
      id: 'm-fu',
      replyTo: 'm-g7',
      kind: 'question',
      blocking: true,
    });
    expect(
      decideState(
        facts({ scope: [ROOT, gate], openQuestions: [future, followUp] })
      ).state
    ).toBe('WORKING');
  });

  it('carries the review and landing stages', () => {
    expect(
      decideState(facts({ skill: 'handoff', task: handoffTask('review') }))
        .stage
    ).toBe('review');
    expect(
      decideState(facts({ skill: 'handoff', task: handoffTask('landing') }))
        .stage
    ).toBe('landing');
  });
});

describe('project', () => {
  it('writes a COMPLETED task with the answer as status and artifact, in canonical ProtoJSON', () => {
    const json = project(facts({ answer, scope: [ROOT, answer] }), view);
    expect(json.status.state).toBe('TASK_STATE_COMPLETED');
    expect(json.status.message?.parts[0].text).toBe('Yes, final.');
    expect(json.artifacts?.[0]).toMatchObject({
      artifactId: 'answer',
      parts: [{ text: 'Yes, final.' }, { data: { choice: 'yes' } }],
    });
    expect(json.history?.map((m) => m.messageId)).toEqual(['c-1', 'm-ans']);
    expect(Task.toJSON(Task.fromJSON(json))).toMatchObject({
      id: 'm-root',
      status: { state: 'TASK_STATE_COMPLETED' },
    });
  });

  // A port that leaks a gate into scope must not leak its answer either.
  it('never shows an answer to a gate as history or status', () => {
    const gate = msg({
      id: 'm-gh',
      replyTo: 'm-root',
      from: 'agent:dispatch',
      kind: 'question',
      body: 'Run `SECRET_INPUT`?',
      data: { type: 'future-gate' },
    });
    const gateAnswer = msg({
      id: 'm-gha',
      replyTo: 'm-gh',
      kind: 'answer',
      body: 'Approved SECRET_INPUT',
    });
    const json = project(facts({ scope: [ROOT, gate, gateAnswer] }), view);
    expect(json.history?.map((m) => m.messageId)).toEqual(['c-1']);
    expect(json.status.message?.parts[0].text).toBe('Working.');
    expect(JSON.stringify(json)).not.toContain('SECRET_INPUT');
  });

  it('caps history, and historyLength 0 sends none', () => {
    const scope = [
      ROOT,
      ...Array.from({ length: 60 }, (_, i) =>
        msg({ id: `m-h${String(i).padStart(2, '0')}`, replyTo: 'm-root' })
      ),
    ];
    expect(project(facts({ scope }), view).history).toHaveLength(50);
    expect(
      project(facts({ scope }), { ...view, historyLength: 0 }).history
    ).toEqual([]);
  });

  // Clients, the TCK among them, read the first artifact as the result.
  it('publishes host artifacts ahead of its own', () => {
    const hosted = {
      artifactId: 'output',
      name: 'output.txt',
      parts: [
        {
          url: 'https://example.com/output.txt',
          mediaType: 'text/plain',
          filename: 'output.txt',
        },
      ],
    };
    const json = project(facts({ answer, hostArtifacts: [hosted] }), view);
    expect(json.artifacts?.map((a) => a.artifactId)).toEqual([
      'output',
      'answer',
    ]);
  });

  it('writes a raw host part as base64 the SDK reads back', () => {
    const raw = Buffer.from('TCK file content').toString('base64');
    const hosted = {
      artifactId: 'output',
      parts: [{ raw, mediaType: 'text/plain', filename: 'output.txt' }],
    };
    const json = project(facts({ answer, hostArtifacts: [hosted] }), view);
    expect(Task.toJSON(Task.fromJSON(json))).toMatchObject({
      artifacts: [{ parts: [{ raw }] }, { artifactId: 'answer' }],
    });
  });

  it('omits artifacts when not asked for', () => {
    expect(
      project(facts({ answer }), { ...view, includeArtifacts: false }).artifacts
    ).toBeUndefined();
  });

  it('writes the gate extension, never the gate payload, while AUTH_REQUIRED', () => {
    const f = facts({
      skill: 'handoff',
      task: handoffTask('draft', false),
      openGates: [
        { id: 'm-g', type: 'task-proposal', openedAt: ROOT.createdAt },
      ],
    });
    const json = project(f, {
      ...view,
      extensions: new Set([GATE_URI, WORK_URI, ENVELOPE_URI]),
    });
    expect(json.status.message?.metadata?.[GATE_URI]).toEqual({
      gates: [
        {
          id: 'm-g',
          type: 'task-proposal',
          openedAt: ROOT.createdAt,
          waitingOn: 'owner',
        },
      ],
    });
    expect(json.status.message?.parts[0].text).toBe(
      'Waiting for the project owner to approve this handoff.'
    );
    expect(JSON.stringify(json)).not.toContain('"type":"task-proposal","task"');
    expect(json.metadata?.[WORK_URI]).toEqual({
      task: 't-a1b2c3',
      title: 'Rate-limit uploads',
      status: 'draft',
    });
  });

  it('changes its key when the state or scope changes, not otherwise', () => {
    const before = projectionKey(facts());
    expect(projectionKey(facts())).toBe(before);
    expect(projectionKey(facts({ answer }))).not.toBe(before);
    expect(
      projectionKey(
        facts({ scope: [ROOT, msg({ id: 'm-new', replyTo: 'm-root' })] })
      )
    ).not.toBe(before);
  });

  it('changes its key when host artifacts change', () => {
    const chunk = (text: string) => ({
      artifactId: 'chunked',
      parts: [{ text }],
    });
    const first = projectionKey(facts({ hostArtifacts: [chunk('chunk-1 ')] }));
    expect(first).not.toBe(projectionKey(facts()));
    expect(
      projectionKey(facts({ hostArtifacts: [chunk('chunk-2')] }))
    ).not.toBe(first);
  });
});
