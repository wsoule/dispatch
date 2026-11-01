import { describe, expect, it } from 'bun:test';

import { buildOp, verifyEntry } from '../../src/federation/chain.js';
import type { ChainHead } from '../../src/federation/chain.js';
import {
  CONTENT_TYPES,
  contentKeyRequest,
  decryptContent,
  encryptContent,
  generateContentKey,
  isContentEnvelope,
  isContentKeyRequest,
  runTag,
} from '../../src/federation/content.js';
import type { ContentEnvelope } from '../../src/federation/content.js';
import { generateReplicaKeys } from '../../src/federation/keys.js';
import { ZERO_HASH } from '../../src/federation/ops.js';

const key = generateContentKey();
const EPOCH = 'e'.repeat(64);
const REPLICA = 'alice-0000000a';

function envelope(
  body: Parameters<typeof encryptContent>[0]['body'] = { task: 't-1' },
  type = 'task',
  seq = 7
): ContentEnvelope {
  return encryptContent({
    replica: REPLICA,
    seq,
    type,
    body,
    epoch: EPOCH,
    key,
  });
}

describe('team content', () => {
  it('round-trips every content type under its key', () => {
    for (const type of CONTENT_TYPES) {
      const body = { type, nested: { list: [1, 'two', null] } };
      const sealed = envelope(body, type);
      expect(isContentEnvelope(sealed)).toBe(true);
      expect(sealed.epoch).toBe(EPOCH);
      expect(JSON.stringify(sealed)).not.toContain('nested');
      expect(
        decryptContent({ replica: REPLICA, seq: 7, type, body: sealed }, key)
      ).toEqual(body);
    }
  });

  it('refuses a type outside CONTENT_TYPES and a key of the wrong length', () => {
    expect(() => envelope({}, 'mail')).toThrow('not team content');
    expect(() =>
      encryptContent({
        replica: REPLICA,
        seq: 1,
        type: 'task',
        body: {},
        epoch: EPOCH,
        key: Buffer.alloc(16),
      })
    ).toThrow('32 bytes');
  });

  it('fails closed on a tampered ciphertext or nonce', () => {
    const sealed = envelope();
    const flip = (s: string) =>
      s.startsWith('A') ? `B${s.slice(1)}` : `A${s.slice(1)}`;
    for (const body of [
      { ...sealed, ct: flip(sealed.ct) },
      { ...sealed, nonce: flip(sealed.nonce) },
    ])
      expect(() =>
        decryptContent({ replica: REPLICA, seq: 7, type: 'task', body }, key)
      ).toThrow();
  });

  it('fails closed when the ciphertext moves to another replica, seq or type', () => {
    const body = envelope();
    const moved = [
      { replica: 'mallory-0000000f', seq: 7, type: 'task' },
      { replica: REPLICA, seq: 8, type: 'task' },
      { replica: REPLICA, seq: 7, type: 'doc' },
    ];
    for (const at of moved)
      expect(() => decryptContent({ ...at, body }, key)).toThrow();
  });

  it('fails closed under another key', () => {
    const body = envelope();
    expect(() =>
      decryptContent(
        { replica: REPLICA, seq: 7, type: 'task', body },
        generateContentKey()
      )
    ).toThrow();
  });

  it('refuses a body that is no envelope', () => {
    expect(isContentEnvelope({ task: 't-1' })).toBe(false);
    expect(isContentEnvelope(null)).toBe(false);
    expect(() =>
      decryptContent(
        { replica: REPLICA, seq: 7, type: 'task', body: { task: 't-1' } },
        key
      )
    ).toThrow('not a content envelope');
  });

  it('tags a run id deterministically per key', () => {
    expect(runTag(key, 'run-1')).toBe(runTag(key, 'run-1'));
    expect(runTag(key, 'run-1')).toMatch(/^[0-9a-f]{64}$/);
    expect(runTag(key, 'run-1')).not.toBe(runTag(key, 'run-2'));
    expect(runTag(key, 'run-1')).not.toBe(
      runTag(generateContentKey(), 'run-1')
    );
  });

  it('keeps presence kind, a tagged run and replica caps in the clear', () => {
    const run = envelope(
      {
        kind: 'run',
        run: 'run-1',
        task: 't-1',
        runKind: 'execute',
        live: true,
      },
      'presence'
    );
    expect(run.kind).toBe('run');
    expect(run.run).toBe(runTag(key, 'run-1'));
    expect(JSON.stringify(run)).not.toContain('t-1');
    const replica = envelope(
      { kind: 'replica', build: '1', device: 'd', wall: 1, caps: ['relay'] },
      'presence'
    );
    expect(replica).toMatchObject({ kind: 'replica', caps: ['relay'] });
    expect(replica.run).toBeUndefined();
    const task = envelope({ kind: 'run', run: 'r' }, 'task');
    expect(task.kind).toBeUndefined();
    expect(task.run).toBeUndefined();
  });

  // The relay verifies content ops unchanged: an envelope is a plain body.
  it('signs and verifies a content op whose body is an envelope', () => {
    const keys = generateReplicaKeys();
    const keyOp = buildOp(
      {
        replica: REPLICA,
        seq: 1,
        prev: ZERO_HASH,
        hlc: `1758880000000.0000.${REPLICA}`,
        type: 'key',
        body: { handle: 'alice' },
      },
      keys.signPriv
    );
    const first = verifyEntry(null, keyOp, keys.signPub);
    if (!first.ok) throw new Error(first.reason);
    const head: ChainHead = first.head;
    const body = envelope({ kind: 'run', run: 'run-1' }, 'presence', 2);
    const op = buildOp(
      {
        replica: REPLICA,
        seq: 2,
        prev: head.hash,
        hlc: `1758880000001.0000.${REPLICA}`,
        type: 'presence',
        body,
      },
      keys.signPriv
    );
    expect(op.to).toBeUndefined();
    expect(op.sealed).toBeUndefined();
    expect(verifyEntry(head, op, keys.signPub).ok).toBe(true);
    expect(decryptContent(op, key)).toEqual({ kind: 'run', run: 'run-1' });
  });

  it('carries wants in the clear on replica presence only', () => {
    const wants = ['a'.repeat(64)];
    const replica = encryptContent({
      replica: REPLICA,
      seq: 3,
      type: 'presence',
      body: { kind: 'replica', caps: ['relay'] },
      epoch: EPOCH,
      key,
      wants,
    });
    expect(replica.wants).toEqual(wants);
    expect(replica.caps).toEqual(['relay']);
    const run = encryptContent({
      replica: REPLICA,
      seq: 4,
      type: 'presence',
      body: { kind: 'run', run: 'r' },
      epoch: EPOCH,
      key,
      wants,
    });
    expect(run.wants).toBeUndefined();
    expect(isContentKeyRequest(replica)).toBe(false);
  });

  it('asks for keys with a hint-only envelope that never decrypts', () => {
    const ask = contentKeyRequest({
      epoch: EPOCH,
      caps: ['relay'],
      wants: [EPOCH],
    });
    expect(isContentEnvelope(ask)).toBe(true);
    expect(isContentKeyRequest(ask)).toBe(true);
    expect(ask).toMatchObject({
      kind: 'replica',
      caps: ['relay'],
      wants: [EPOCH],
    });
    expect(() =>
      decryptContent(
        { replica: REPLICA, seq: 5, type: 'presence', body: ask },
        key
      )
    ).toThrow();
  });
});
