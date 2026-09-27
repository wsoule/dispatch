import {
  buildOp,
  ed25519FromSeed,
  opHash,
  publicOfPrivate,
  sha256Hex,
  stubOf,
  ZERO_HASH,
} from '@dispatch/protocol/federation';
import type {
  FederatedOp,
  LogEntry,
  PresenceBody,
} from '@dispatch/protocol/federation';
import { writeFileSync } from 'node:fs';

// Regenerates vectors/chain from fixed seeds: `bun
// packages/federation/scripts/chain-vectors.ts`, then `moon run root:format`.
// Nothing is sealed, so the golden test can compare the output with the files.

export const CHAIN_VECTORS_DIR = new URL('../vectors/chain/', import.meta.url);

export interface ChainVector {
  name: string;
  replica: string;
  entries: LogEntry[];
  expect: { accepted: number[]; halted: string | null };
}

const REPLICA = 'ada-0000000a';
// The fixed PKCS8 prefix of an X25519 private key; the 32-byte seed follows.
const X25519_PKCS8 = '302e020100300506032b656e04220420';

const seed = (label: string) =>
  Buffer.from(sha256Hex(`dispatch chain vectors: ${label}`), 'hex');
// Labels whose keys and signatures hold no base64url run the spell check flags.
const sign = ed25519FromSeed(seed('sign 3'));
const sealPub = publicOfPrivate(
  Buffer.concat([Buffer.from(X25519_PKCS8, 'hex'), seed('seal')]).toString(
    'base64url'
  )
);
const hlc = (ms: number) => `${String(ms).padStart(13, '0')}.0000.${REPLICA}`;

function keyOp(): FederatedOp {
  return buildOp(
    {
      replica: REPLICA,
      seq: 1,
      prev: ZERO_HASH,
      hlc: hlc(1_790_000_000_000),
      type: 'key',
      body: {
        handle: 'ada',
        device: 'laptop',
        build: '0.40.0',
        signPub: sign.signPub,
        sealPub,
        legacy: null,
      },
    },
    sign.signPriv
  );
}

// The next op after `prev`, one millisecond later on the clock.
function next(
  prev: FederatedOp,
  type: string,
  body: FederatedOp['body']
): FederatedOp {
  const ms = Number(prev.hlc.slice(0, 13)) + 1;
  return buildOp(
    {
      replica: REPLICA,
      seq: prev.seq + 1,
      prev: opHash(prev),
      hlc: hlc(ms),
      type,
      body,
    },
    sign.signPriv
  );
}

const taskPut = (n: number) => ({
  task: 't-00000a01',
  kind: 'put',
  fields: { n },
});

const halted = (seq: number, reason: string) =>
  `${REPLICA}'s log fails verification at seq ${seq}: ${reason}; revoke it, or have it push again`;

export function makeChainVectors(): ChainVector[] {
  const key = keyOp();
  const t2 = next(key, 'task', taskPut(2));
  const t3 = next(t2, 'task', taskPut(3));
  const t4 = next(t3, 'task', taskPut(4));
  const presence: PresenceBody = {
    kind: 'replica',
    build: '0.40.0',
    device: 'laptop',
    wall: 1_790_000_000_005,
  };
  const p5 = next(t4, 'presence', presence);
  const fork3 = next(t2, 'task', taskPut(99));
  return [
    {
      name: 'basic',
      replica: REPLICA,
      entries: [key, t2, t3, t4, stubOf(p5)],
      expect: { accepted: [1, 2, 3, 4, 5], halted: null },
    },
    {
      name: 'fork',
      replica: REPLICA,
      entries: [key, t2, t3, fork3],
      expect: {
        accepted: [1, 2],
        halted: halted(3, 'two ops share this seq'),
      },
    },
    {
      name: 'halted-stub',
      replica: REPLICA,
      entries: [key, stubOf(t2), t3],
      expect: {
        accepted: [1],
        halted: halted(2, 'a task op cannot be a stub'),
      },
    },
  ];
}

if (import.meta.main) {
  for (const v of makeChainVectors()) {
    writeFileSync(
      new URL(`${v.name}.json`, CHAIN_VECTORS_DIR),
      `${JSON.stringify(v, null, 2)}\n`
    );
  }
}
