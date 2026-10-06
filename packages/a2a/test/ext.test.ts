import { describe, expect, it } from 'bun:test';

import {
  activatedExtensions,
  checkMetadataBudget,
  MAX_METADATA_BYTES,
  parseEnvelopeExt,
  parseWorkExt,
  utf8Bytes,
} from '../src/ext.js';
import { ENVELOPE_URI, GATE_URI, WORK_URI } from '../src/uris.js';

describe('envelope extension', () => {
  it('reads recipients, choices and message refs', () => {
    expect(
      parseEnvelopeExt({
        to: ['human:alice'],
        kind: 'question',
        choices: ['yes', 'no'],
        refs: [{ type: 'message', id: 'm-1' }],
      })
    ).toEqual({
      to: ['human:alice'],
      kind: 'question',
      choices: ['yes', 'no'],
      refs: [{ type: 'message', id: 'm-1' }],
    });
  });

  it('ignores from, id and thread sent by a client', () => {
    expect(
      parseEnvelopeExt({ from: 'human:wyat', id: 'm-9', thread: 'm-9' })
    ).toEqual({});
  });

  it.each([
    [{ urgent: true }, 'forbidden', 'urgent'],
    [{ wake: 'request' }, 'forbidden', 'wake'],
    [{ kind: 'x-deploy' }, 'forbidden', 'kind'],
    [{ kind: 'shout' }, 'invalid', 'kind'],
    [{ refs: [{ type: 'file', id: 'a.ts' }] }, 'invalid', 'refs[0].type'],
    [
      { refs: [{ type: 'message', id: 'm-1', at: 'abc' }] },
      'invalid',
      'refs[0].at',
    ],
    [
      { choices: Array.from({ length: 21 }, (_, i) => `c${i}`) },
      'invalid',
      'choices',
    ],
    [{ to: ['human:a\nhuman:b'] }, 'invalid', 'to[0]'],
  ])('refuses %j', (raw, code, field) => {
    expect(() => parseEnvelopeExt(raw)).toThrow(
      expect.objectContaining({ code, field })
    );
  });
});

describe('work extension', () => {
  it('reads a handoff request', () => {
    expect(
      parseWorkExt({
        skill: 'handoff',
        title: 'Rate-limit uploads',
        acceptance: ['429 after 10/min'],
        labels: ['api'],
      })
    ).toEqual({
      skill: 'handoff',
      title: 'Rate-limit uploads',
      acceptance: ['429 after 10/min'],
      labels: ['api'],
    });
  });

  it('is null when absent', () => {
    expect(parseWorkExt(undefined)).toBeNull();
  });

  it('counts limits in UTF-8 bytes, not characters', () => {
    const title = '🚀'.repeat(51); // 51 characters, 204 bytes
    expect(utf8Bytes(title)).toBe(204);
    expect(() => parseWorkExt({ skill: 'handoff', title })).toThrow(
      expect.objectContaining({ field: 'work.title' })
    );
  });

  it.each([
    [{ skill: 'deploy' }, 'work.skill'],
    [{ skill: 'handoff' }, 'work.title'],
    [
      { skill: 'handoff', title: 'x', acceptance: ['a\nb'] },
      'work.acceptance[0]',
    ],
    [
      {
        skill: 'handoff',
        title: 'x',
        writes: Array.from({ length: 51 }, () => 'a.ts'),
      },
      'work.writes',
    ],
    [
      { skill: 'handoff', title: 'x', writes: ['/etc/passwd'] },
      'work.writes[0]',
    ],
    [
      {
        skill: 'handoff',
        title: 'x',
        writes: ['src/ok.ts', 'src/../../outside.ts'],
      },
      'work.writes[1]',
    ],
    [
      { skill: 'handoff', title: 'x', writes: ['C:\\repo\\a.ts'] },
      'work.writes[0]',
    ],
    [{ skill: 'handoff', title: 'x', priority: 'asap' }, 'work.priority'],
    [
      { skill: 'handoff', title: 'x', labels: ['l'.repeat(51)] },
      'work.labels[0]',
    ],
  ])('refuses %j', (raw, field) => {
    expect(() => parseWorkExt(raw)).toThrow(
      expect.objectContaining({ code: 'invalid', field })
    );
  });
});

describe('activation', () => {
  it('reads the header and the message’s own list, ignoring unknown URIs', () => {
    const active = activatedExtensions(
      `${ENVELOPE_URI}, https://example.com/other`,
      [WORK_URI]
    );
    expect<string[]>([...active].sort()).toEqual(
      [ENVELOPE_URI, WORK_URI].sort()
    );
    expect(active.has(GATE_URI)).toBe(false);
  });
});

describe('metadata budget', () => {
  it('fits every extension field at its maximum, with refs at the longest id a caller can see', () => {
    const line = (n: number) => 'x'.repeat(n);
    const metadata = {
      [WORK_URI]: {
        skill: 'handoff',
        title: line(200),
        acceptance: Array.from({ length: 20 }, () => line(500)),
        writes: Array.from({ length: 50 }, () => line(512)),
        priority: 'medium',
        labels: Array.from({ length: 10 }, () => line(50)),
      },
      [ENVELOPE_URI]: {
        to: Array.from(
          { length: 50 },
          (_, i) => `human:teammate-${String(i).padStart(3, '0')}`
        ),
        kind: 'question',
        replyTo: `m-${line(26)}`,
        choices: Array.from({ length: 20 }, () => line(200)),
        refs: Array.from({ length: 50 }, () => ({
          type: 'message',
          id: `m-${line(26)}`,
        })),
      },
    };
    expect(() => checkMetadataBudget(metadata)).not.toThrow();
  });

  it('refuses metadata over 64 KiB', () => {
    expect(() =>
      checkMetadataBudget({ big: 'x'.repeat(MAX_METADATA_BYTES) })
    ).toThrow(
      expect.objectContaining({ code: 'invalid', field: 'message.metadata' })
    );
  });
});
