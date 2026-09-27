import { Message as A2AMessage } from '@a2a-js/sdk';
import type { Message } from '@dispatch/protocol';
import { describe, expect, it } from 'bun:test';

import { decodeInbound, encodeMessage, outputTextType } from '../src/codec.js';
import { A2AError } from '../src/errors.js';
import { ENVELOPE_URI, WORK_URI } from '../src/uris.js';

const CLIENT = 'agent:wyat/a2a.acme';

function inbound(json: Record<string, unknown>) {
  return decodeInbound(
    A2AMessage.fromJSON({ role: 'ROLE_USER', messageId: 'c-1', ...json })
  );
}

describe('decodeInbound', () => {
  it('turns text, url and data parts into one ask', () => {
    const decoded = inbound({
      parts: [
        { text: 'Is the /sessions response shape final?' },
        { text: 'Second paragraph', mediaType: 'text/markdown' },
        { url: 'https://example.com/spec.pdf', filename: 'spec [v2].pdf' },
        { data: { a: 1 } },
      ],
      metadata: {
        [ENVELOPE_URI]: { to: ['human:alice'], choices: ['yes', 'no'] },
      },
    });
    expect(decoded).toEqual({
      kind: 'open',
      input: {
        clientMessageId: 'c-1',
        contextId: null,
        kind: 'ask',
        to: ['human:alice'],
        replyTo: null,
        body: 'Is the /sessions response shape final?\n\nSecond paragraph\n\n[spec  v2 .pdf](https://example.com/spec.pdf)',
        data: { [ENVELOPE_URI]: { a: 1 } },
        refs: [],
        choices: ['yes', 'no'],
      },
    });
  });

  it('continues a task when taskId is set', () => {
    expect(
      inbound({
        taskId: 'm-task',
        contextId: 'm-task',
        parts: [{ text: 'eu' }],
      })
    ).toEqual({
      kind: 'continue',
      input: {
        clientMessageId: 'c-1',
        taskId: 'm-task',
        contextId: 'm-task',
        body: 'eu',
        refs: [],
      },
    });
  });

  it('picks the kind from the work and envelope extensions', () => {
    const kind = (metadata: Record<string, unknown>) =>
      (
        inbound({ parts: [{ text: 'x' }], metadata }) as {
          input: { kind: string };
        }
      ).input.kind;
    expect(kind({})).toBe('ask');
    expect(kind({ [ENVELOPE_URI]: { kind: 'notice' } })).toBe('notice');
    expect(kind({ [WORK_URI]: { skill: 'status' } })).toBe('status');
    expect(kind({ [WORK_URI]: { skill: 'handoff', title: 'Do it' } })).toBe(
      'handoff'
    );
    expect(() => kind({ [ENVELOPE_URI]: { kind: 'answer' } })).toThrow(
      expect.objectContaining({ field: 'kind' })
    );
  });

  it('refuses raw parts and non-text text media types as CONTENT_TYPE_NOT_SUPPORTED', () => {
    expect(() => inbound({ parts: [{ raw: 'aGk=' }] })).toThrow(A2AError);
    expect(() =>
      inbound({ parts: [{ text: '<b>', mediaType: 'text/html' }] })
    ).toThrow(
      expect.objectContaining({ reason: 'CONTENT_TYPE_NOT_SUPPORTED' })
    );
  });

  it('requires a one-line messageId of at most 200 bytes', () => {
    expect(() => inbound({ messageId: '', parts: [{ text: 'x' }] })).toThrow(
      expect.objectContaining({ field: 'message.messageId' })
    );
    expect(() =>
      inbound({ messageId: 'é'.repeat(101), parts: [{ text: 'x' }] })
    ).toThrow(expect.objectContaining({ field: 'message.messageId' }));
  });

  it('caps url parts at 20', () => {
    const parts = Array.from({ length: 21 }, (_, i) => ({
      url: `https://example.com/${i}`,
    }));
    expect(() => inbound({ parts })).toThrow(
      expect.objectContaining({ field: 'message.parts' })
    );
  });
});

describe('encodeMessage', () => {
  const base: Message = {
    id: 'm-2',
    thread: 'm-1',
    replyTo: 'm-1',
    from: 'human:wyat',
    to: [CLIENT],
    kind: 'answer',
    body: 'Yes, final.',
    refs: [{ type: 'commit', id: 'abc123' }],
    choice: 'yes',
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: '2026-09-25T10:00:00.000Z',
  };
  const view = {
    client: CLIENT,
    textMediaType: 'text/markdown' as const,
    extensions: new Set<never>(),
    clientIds: {},
    lookup: () => null,
    taskId: 'm-1',
  };

  it('writes a plain agent message without extension metadata', () => {
    expect(encodeMessage(base, view)).toEqual({
      messageId: 'm-2',
      contextId: 'm-1',
      taskId: 'm-1',
      role: 'ROLE_AGENT',
      parts: [{ text: 'Yes, final.', mediaType: 'text/markdown' }],
    });
  });

  it('adds the envelope when active, never a to', () => {
    const out = encodeMessage(base, {
      ...view,
      extensions: new Set([ENVELOPE_URI]),
    });
    expect(out.extensions).toEqual([ENVELOPE_URI]);
    expect(out.metadata?.[ENVELOPE_URI]).toEqual({
      id: 'm-2',
      thread: 'm-1',
      from: 'human:wyat',
      kind: 'answer',
      replyTo: 'm-1',
      choice: 'yes',
      refs: [{ type: 'commit', id: 'abc123' }],
    });
  });

  it('gives the client its own messageId back and unwraps its data', () => {
    const own: Message = {
      ...base,
      id: 'm-1',
      replyTo: null,
      from: CLIENT,
      to: ['human:wyat'],
      kind: 'question',
      data: { [ENVELOPE_URI]: { a: 1 } },
    };
    const out = encodeMessage(own, { ...view, clientIds: { 'm-1': 'c-1' } });
    expect(out.role).toBe('ROLE_USER');
    expect(out.messageId).toBe('c-1');
    expect(out.parts[1]).toEqual({
      data: { a: 1 },
      mediaType: 'application/json',
    });
  });

  it('never writes gate data or a system marker’s data', () => {
    const gate: Message = {
      ...base,
      data: { type: 'wake', target: 'task:t-000001', message: 'm-x' },
    };
    const close: Message = {
      ...base,
      from: 'agent:dispatch',
      data: { type: 'x-closed', reason: 'declined' },
    };
    expect(encodeMessage(gate, view).parts).toHaveLength(1);
    expect(encodeMessage(close, view).parts).toHaveLength(1);
  });

  it('never writes the data of an answer to a gate, or gate data of a type it does not know', () => {
    const gate: Message = {
      ...base,
      id: 'm-g',
      kind: 'question',
      from: 'agent:dispatch',
      data: { type: 'future-gate', detail: 'SECRET' },
    };
    const gateAnswer: Message = {
      ...base,
      replyTo: 'm-g',
      data: { note: 'SECRET' },
    };
    const lookup = (id: string) => (id === 'm-g' ? gate : null);
    expect(encodeMessage(gate, { ...view, lookup }).parts).toHaveLength(1);
    expect(encodeMessage(gateAnswer, { ...view, lookup }).parts).toHaveLength(
      1
    );
    expect(encodeMessage(gateAnswer, view).parts).toHaveLength(2);
  });
});

describe('outputTextType', () => {
  it('prefers markdown, falls back to plain, refuses neither', () => {
    expect(outputTextType([])).toBe('text/markdown');
    expect(outputTextType(['text/plain', 'application/json'])).toBe(
      'text/plain'
    );
    expect(outputTextType(['*/*'])).toBe('text/markdown');
    expect(() => outputTextType(['image/png'])).toThrow(
      expect.objectContaining({ reason: 'CONTENT_TYPE_NOT_SUPPORTED' })
    );
  });
});
