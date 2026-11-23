import type { Message, OverseerRecord } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import {
  actionReply,
  committedSegments,
  gateForCard,
  toolCallReply,
} from '../src/overseer';

function gate(data: object): Message {
  return {
    id: `g-${JSON.stringify(data).length}`,
    thread: 'th',
    replyTo: null,
    from: 'agent:dispatch',
    to: ['human:ada'],
    kind: 'question',
    body: '',
    refs: [],
    urgent: false,
    blocking: true,
    wake: 'none',
    createdAt: '2026-11-14T10:00:00.000Z',
    data,
  } as Message;
}

const actionGate = gate({
  type: 'overseer-action',
  conversation: 'c-1',
  actionId: 'a-1',
  summary: 'Cancel run r-1',
});
const approvalGate = gate({
  type: 'tool-approval',
  requestId: 'q-1',
  conversation: 'c-1',
  tool: 'Bash',
  input: { command: 'ls' },
  floor: false,
});

describe('answering the Overseer from the phone', () => {
  test('confirms or cancels an action with the protocol choices', () => {
    expect(actionReply(true)).toEqual({ body: '', choice: 'confirm' });
    expect(actionReply(false)).toEqual({ body: '', choice: 'cancel' });
  });

  test('allows a parked tool call once only', () => {
    expect(toolCallReply(true).choice).toBe('approve');
    expect(toolCallReply(false).choice).toBe('deny');
  });

  test('finds the open gate for a card in this conversation only', () => {
    const gates = [actionGate, approvalGate];
    expect(gateForCard(gates, 'c-1', { kind: 'action', actionId: 'a-1' })).toBe(
      actionGate
    );
    expect(
      gateForCard(gates, 'c-1', { kind: 'approval', requestId: 'q-1' })
    ).toBe(approvalGate);
    expect(
      gateForCard(gates, 'c-2', { kind: 'action', actionId: 'a-1' })
    ).toBeNull();
  });

  test('knows which live segments the record already holds', () => {
    const record = {
      messages: [
        { role: 'assistant', text: 'hi', at: '', streamId: 's-1' },
        { role: 'user', text: 'yo', at: '' },
      ],
    } as unknown as OverseerRecord;
    expect([...committedSegments(record)]).toEqual(['s-1']);
    expect(committedSegments(undefined).size).toBe(0);
  });
});
