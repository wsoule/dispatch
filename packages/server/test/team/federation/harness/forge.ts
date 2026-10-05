import type { JsonValue, Message } from '@dispatch/protocol';
import {
  buildOp,
  generateReplicaKeys,
  opHash,
  sealPayload,
  stubOf,
  ZERO_HASH,
} from '@dispatch/protocol/federation';
import type { FederatedOp, LogEntry } from '@dispatch/protocol/federation';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Member } from './cluster.js';

// A teammate with push access editing logs by hand, in a scratch clone of the
// branch (`dir`), with its own key where it signs.

function lastSegment(dir: string, replica: string): string {
  const segDir = join(dir, 'fed', replica);
  const names = readdirSync(segDir)
    .filter((n) => /^\d{12}\.jsonl$/.test(n))
    .sort();
  const last = names.at(-1);
  if (last === undefined) throw new Error(`no segment for ${replica}`);
  return join(segDir, last);
}

function linesOf(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
}

// Rewrites the last task line of the replica's last segment with `change`.
function rewriteLastTaskLine(
  dir: string,
  replica: string,
  change: (op: FederatedOp) => LogEntry
): number {
  const file = lastSegment(dir, replica);
  const lines = linesOf(file);
  for (let i = lines.length - 1; i >= 0; i--) {
    const op = JSON.parse(lines[i] ?? '') as FederatedOp;
    if (op.type !== 'task') continue;
    lines[i] = JSON.stringify(change(op));
    writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
    return op.seq;
  }
  throw new Error(`no task line in ${file}`);
}

/** Puts another title in the last task line, keeping its header and signature. */
export function forgeLastTaskLine(
  dir: string,
  replica: string,
  taskId: string,
  title: string
): void {
  rewriteLastTaskLine(
    dir,
    replica,
    (op) =>
      ({
        ...op,
        body: { task: taskId, kind: 'put', fields: { title } },
      }) as FederatedOp
  );
}

/** Replaces the last task line with its signed stub; the seq replaced. */
export function stubLastTaskLine(dir: string, replica: string): number {
  return rewriteLastTaskLine(dir, replica, (op) => stubOf(op));
}

// The member's signing key, from its keys/replica.json.
function signPrivOf(m: Member): { replica: string; signPriv: string } {
  const stored = JSON.parse(
    readFileSync(join(m.handle.syncDir, 'keys', 'replica.json'), 'utf8')
  ) as { replica: string; signPriv: string };
  return stored;
}

// An HLC `ms` later than `after`, or at `atMs` when given.
function nextHlc(after: string, replica: string, atMs?: number): string {
  const [msText, counterText] = after.split('.');
  const ms = Number(msText);
  const at = atMs ?? ms;
  const counter = at === ms ? Number(counterText) + 1 : 0;
  return `${String(at).padStart(13, '0')}.${String(counter).padStart(4, '0')}.${replica}`;
}

/** Appends an op signed with `m`'s key to its last segment: chained on the
 *  branch's head, or with `seq` -1 a second op at the head's seq (a fork),
 *  or at `hlcMs` for a backdated clock. */
export function appendSignedOp(
  dir: string,
  m: Member,
  op: { type: string; body: JsonValue; hlcMs?: number; seq?: number }
): FederatedOp {
  const { replica, signPriv } = signPrivOf(m);
  const file = lastSegment(dir, replica);
  const entries = linesOf(file).map((l) => JSON.parse(l) as LogEntry);
  const head = entries.at(-1);
  if (head === undefined) throw new Error(`empty segment ${file}`);
  const fork = op.seq === -1;
  const at = fork
    ? head
    : op.seq === undefined
      ? null
      : entries.find((e) => e.seq === op.seq);
  const seq = fork ? head.seq : (op.seq ?? head.seq + 1);
  const prev = fork || at != null ? (at?.prev ?? head.prev) : opHash(head);
  const built = buildOp(
    {
      replica,
      seq,
      prev,
      hlc: nextHlc(head.hlc, replica, op.hlcMs),
      type: op.type,
      body: op.body,
    },
    signPriv
  );
  writeFileSync(
    file,
    `${readFileSync(file, 'utf8')}${JSON.stringify(built)}\n`
  );
  return built;
}

/** Puts a junk line before everything in the replica's first segment. */
export function prependJunk(dir: string, replica: string): void {
  const segDir = join(dir, 'fed', replica);
  const first = readdirSync(segDir)
    .filter((n) => /^\d{12}\.jsonl$/.test(n))
    .sort()[0];
  if (first === undefined) throw new Error(`no segment for ${replica}`);
  const file = join(segDir, first);
  writeFileSync(file, `{"junk":true}\n${readFileSync(file, 'utf8')}`);
}

/** A key op claiming `replica`'s id with a key of its own, in a file named
 *  `name` under that id: a rival claim no roster op names. */
export function rivalClaimFile(
  dir: string,
  replica: string,
  name: string,
  ms: number
): void {
  const k = generateReplicaKeys();
  const op = buildOp(
    {
      replica,
      seq: 1,
      prev: ZERO_HASH,
      hlc: `${String(ms).padStart(13, '0')}.0000.${replica}`,
      type: 'key',
      body: {
        handle: 'mallory',
        device: 'x',
        build: '0',
        signPub: k.signPub,
        sealPub: k.sealPub,
        legacy: null,
      },
    },
    k.signPriv
  );
  mkdirSync(join(dir, 'fed', replica), { recursive: true });
  writeFileSync(join(dir, 'fed', replica, name), `${JSON.stringify(op)}\n`);
}

/** Bloats every segment of `replica`: `bytes` of junk appended after its
 *  lines, or put before them. */
export function bloatSegments(
  dir: string,
  replica: string,
  bytes: number,
  where: 'append' | 'prepend'
): void {
  const segDir = join(dir, 'fed', replica);
  for (const name of readdirSync(segDir).filter((n) =>
    /^\d{12}\.jsonl$/.test(n)
  )) {
    const file = join(segDir, name);
    const junk = `${'x'.repeat(bytes)}\n`;
    const text = readFileSync(file, 'utf8');
    writeFileSync(
      file,
      where === 'append' ? `${text}${junk}` : `${junk}${text}`
    );
  }
}

// A member's keys, as its keys/replica.json holds them.
export function keysOf(m: Member): {
  replica: string;
  signPriv: string;
  sealPub: string;
  sealPriv: string;
} {
  return JSON.parse(
    readFileSync(join(m.handle.syncDir, 'keys', 'replica.json'), 'utf8')
  ) as { replica: string; signPriv: string; sealPub: string; sealPriv: string };
}

/** A mail op on `from`'s log, chained on its branch head: `message.hlc` set
 *  to the op's, one target per `to` member's human homed on its replica, and
 *  sealed to those members' keys. */
export function appendSealedMail(
  dir: string,
  from: Member,
  message: Message,
  to: Member[]
): FederatedOp {
  const { replica, signPriv } = keysOf(from);
  const file = lastSegment(dir, replica);
  const entries = linesOf(file).map((l) => JSON.parse(l) as LogEntry);
  const head = entries.at(-1);
  if (head === undefined) throw new Error(`empty segment ${file}`);
  const seq = head.seq + 1;
  const hlc = nextHlc(head.hlc, replica);
  const recipients = new Map(
    to.map((m) => [keysOf(m).replica, keysOf(m).sealPub])
  );
  const targets = message.to.map((recipient) => {
    const home = to.find((m) => recipient === `human:${m.handle.handle}`);
    return {
      recipient,
      via: 'direct' as const,
      homes: home === undefined ? [] : [keysOf(home).replica],
    };
  });
  const { to: sealedTo, sealed } = sealPayload({
    replica,
    seq,
    type: 'mail',
    payload: { message: { ...message, hlc }, targets } as never,
    recipients,
  });
  const built = buildOp(
    {
      replica,
      seq,
      prev: opHash(head),
      hlc,
      type: 'mail',
      to: sealedTo,
      sealed,
    },
    signPriv
  );
  writeFileSync(
    file,
    `${readFileSync(file, 'utf8')}${JSON.stringify(built)}\n`
  );
  return built;
}

/** Appends the replica's last line again: a replayed push. */
export function duplicateLastLine(dir: string, replica: string): void {
  const file = lastSegment(dir, replica);
  const lines = linesOf(file);
  const last = lines.at(-1);
  if (last === undefined) throw new Error(`empty segment ${file}`);
  writeFileSync(file, `${readFileSync(file, 'utf8')}${last}\n`);
}
