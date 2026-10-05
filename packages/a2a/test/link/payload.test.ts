import { describe, expect, it } from 'bun:test';

import {
  checkLinkPayload,
  MAX_LINK_PAYLOAD_BYTES,
  sealableLinkPayload,
} from '../../src/link/payload.js';

const MESSAGE = {
  messageId: 'm-1',
  role: 'ROLE_USER' as const,
  parts: [{ text: 'Is /sessions final?' }],
};
const STATUS = {
  statusUpdate: {
    taskId: 't-1',
    contextId: 'c-1',
    status: { state: 'TASK_STATE_WORKING', timestamp: '2026-10-05T00:00:00Z' },
  },
};

describe('checkLinkPayload', () => {
  it('accepts each kind, checked field by field', () => {
    for (const p of [
      { kind: 'send', message: MESSAGE },
      {
        kind: 'send',
        message: MESSAGE,
        configuration: { returnImmediately: true },
      },
      { kind: 'event', taskId: 't-1', event: STATUS },
      {
        kind: 'event',
        taskId: 't-1',
        event: {
          task: {
            id: 't-1',
            contextId: 'c-1',
            status: { state: 'TASK_STATE_COMPLETED' },
          },
        },
      },
      { kind: 'cancel', taskId: 't-1' },
      { kind: 'resync', taskId: 't-1' },
      { kind: 'unpair', id: 'A'.repeat(22), at: '2026-10-05T00:00:00.000Z' },
      {
        kind: 'key-change',
        statement: {
          v: 1,
          old: 'a'.repeat(43),
          new: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
          at: '2026-10-05T00:00:00.000Z',
          sig: 's',
        },
      },
      {
        kind: 'key-change',
        statement: {
          v: 1,
          revoked: 'a'.repeat(43),
          at: '2026-10-05T00:00:00.000Z',
          sig: 's',
        },
      },
    ])
      expect(checkLinkPayload(p)).toMatchObject({ ok: true });
  });

  it('refuses unknown kinds, extra fields and bad fields, and never throws', () => {
    for (const p of [
      null,
      'send',
      [],
      { kind: 'nope' },
      { kind: 'cancel', taskId: 't-1', extra: 1 },
      { kind: 'cancel', taskId: 'two\nlines' },
      { kind: 'cancel', taskId: 'x'.repeat(513) },
      { kind: 'send', message: { messageId: 'm', role: 'ROLE_USER' } },
      { kind: 'send', message: 'hello' },
      { kind: 'send', message: MESSAGE, configuration: { blocking: true } },
      { kind: 'event', taskId: 't-1', event: { status: {} } },
      { kind: 'event', taskId: 't-1', event: { task: {}, message: {} } },
      { kind: 'unpair', id: 'A'.repeat(22), at: 'yesterday' },
      { kind: 'unpair', at: '2026-10-05T00:00:00.000Z' },
      { kind: 'key-change', statement: { v: 2 } },
    ]) {
      const r = checkLinkPayload(p);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(typeof r.problem).toBe('string');
    }
  });
});

describe('sealableLinkPayload', () => {
  it('reports a payload too large to seal as oversize before any sealing', () => {
    expect(sealableLinkPayload({ kind: 'cancel', taskId: 't-1' })).toBe('ok');
    const big = {
      kind: 'send' as const,
      message: {
        ...MESSAGE,
        parts: [{ text: 'x'.repeat(MAX_LINK_PAYLOAD_BYTES) }],
      },
    };
    expect(sealableLinkPayload(big)).toBe('oversize');
  });
});

describe('relay re-review N3: the SDK-decoded form is what passes', () => {
  it('drops fields the A2A schema does not have', () => {
    const r = checkLinkPayload({
      kind: 'send',
      message: { ...MESSAGE, junk: '<script>' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok || r.payload.kind !== 'send') throw new Error('refused');
    expect(JSON.stringify(r.payload.message)).not.toContain('junk');
    const e = checkLinkPayload({
      kind: 'event',
      taskId: 't-1',
      event: { statusUpdate: { ...STATUS.statusUpdate, junk: 1 } },
    });
    if (!e.ok || e.payload.kind !== 'event') throw new Error('refused');
    expect(JSON.stringify(e.payload.event)).not.toContain('junk');
  });
});

describe('the event payload names the send it answers (T54)', () => {
  it('keeps a valid for, and refuses a bad one', () => {
    const ok = checkLinkPayload({
      kind: 'event',
      taskId: 't-1',
      for: 'm-1',
      event: STATUS,
    });
    expect(ok.ok && ok.payload.kind === 'event' && ok.payload.for).toBe('m-1');
    for (const bad of ['', 'a\nb', 7])
      expect(
        checkLinkPayload({
          kind: 'event',
          taskId: 't-1',
          for: bad,
          event: STATUS,
        }).ok
      ).toBe(false);
  });
});
