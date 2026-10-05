import type { LinkPayload } from '@dispatch/a2a';
import type { JsonValue } from '@dispatch/protocol';
import {
  buildOp,
  generateReplicaKeys,
  opHash,
  sealPayload,
  ZERO_HASH,
} from '@dispatch/protocol/federation';
import type { FederatedOp } from '@dispatch/protocol/federation';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultAsyncGitRunner } from '../../../src/sync/worktree.js';
import { SyncRepo } from '../../../src/team/boardSync/repo.js';
import { linkReplicaId, LinkService } from '../../../src/team/links/service.js';
import type { LinkKeys } from '../../../src/team/links/service.js';
import { runGitSync } from '../../orchestrator/helpers.js';

const BRANCH = 'dispatch-a2a-L1';
const T0 = Date.parse('2026-10-05T12:00:00.000Z');

const MESSAGE = {
  messageId: 'm-1',
  role: 'ROLE_USER',
  parts: [{ text: 'Is /sessions final?' }],
};
export const send = (id = 'm-1'): LinkPayload =>
  ({
    kind: 'send',
    message: { ...MESSAGE, messageId: id },
  }) as unknown as LinkPayload;
export const event = (timestamp: string): LinkPayload =>
  ({
    kind: 'event',
    taskId: 't-1',
    event: {
      statusUpdate: {
        taskId: 't-1',
        contextId: 'c-1',
        status: { state: 'TASK_STATE_WORKING', timestamp },
      },
    },
  }) as unknown as LinkPayload;

/** A scratch bare remote and a clock both sides read. */
export function scratch() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-link-')));
  const remote = join(dir, 'remote.git');
  runGitSync(dir, ['init', '-q', '--bare', '-b', 'main', remote]);
  const clock = { ms: T0 };
  return {
    dir,
    remote,
    clock,
    now: () => new Date(clock.ms),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export type Scratch = ReturnType<typeof scratch>;

export interface Side {
  name: string;
  keys: LinkKeys;
  service: LinkService;
  got: { payload: LinkPayload; seq: number }[];
  state: { paired: boolean; peer: LinkKeys | null; park: boolean };
}

/** A LinkService for `name`, delivering into `got`. */
function side(s: Scratch, name: string, keys = linkKeys()): Side {
  const got: Side['got'] = [];
  const state: Side['state'] = { paired: true, peer: null, park: false };
  const service = new LinkService({
    dir: join(s.dir, name),
    link: { id: 'L1', remote: s.remote, branch: BRANCH },
    keys,
    peer: () =>
      state.peer === null
        ? null
        : { signPub: state.peer.signPub, sealPub: state.peer.sealPub },
    paired: () => state.paired,
    deliver: (payload, from) => {
      if (state.park) return 'parked';
      got.push({ payload, seq: from.seq });
      return 'applied';
    },
    now: s.now,
  });
  return { name, keys, service, got, state };
}

export function linkKeys(): LinkKeys {
  const k = generateReplicaKeys();
  return {
    signPriv: k.signPriv,
    signPub: k.signPub,
    sealPriv: k.sealPriv,
    sealPub: k.sealPub,
  };
}

/** Two sides that know each other's keys. */
export function pairOf(s: Scratch): [Side, Side] {
  const a = side(s, 'ada');
  const b = side(s, 'bob');
  a.state.peer = b.keys;
  b.state.peer = a.keys;
  return [a, b];
}

/** A raw publisher under the given keys: signs any chain it is told to, as a
 *  buggy or hostile peer could, and writes it with its own clone. */
export class RawPeer {
  readonly replica: string;
  readonly repo: SyncRepo;
  readonly ops: FederatedOp[] = [];

  constructor(
    private readonly s: Scratch,
    readonly keys: LinkKeys,
    replica?: string
  ) {
    this.replica = replica ?? linkReplicaId(keys.signPub);
    this.repo = new SyncRepo(
      join(s.dir, `raw-${this.replica}-${Math.random().toString(36).slice(2)}`),
      s.remote,
      BRANCH,
      this.replica,
      defaultAsyncGitRunner
    );
  }

  hlc(seq: number, ms = this.s.clock.ms): string {
    return `${String(ms).padStart(13, '0')}.${String(seq).padStart(4, '0')}.${this.replica}`;
  }

  /** The next op on this chain (or after `after`), not yet written. */
  next(
    fields: {
      type?: 'key' | 'a2a';
      body?: JsonValue;
      payload?: JsonValue;
      to?: LinkKeys;
      hlcMs?: number;
    },
    after: FederatedOp | null = this.ops.at(-1) ?? null
  ): FederatedOp {
    const seq = (after?.seq ?? 0) + 1;
    const type = fields.type ?? 'a2a';
    const sealed =
      fields.payload === undefined || fields.to === undefined
        ? undefined
        : sealPayload({
            replica: this.replica,
            seq,
            type: 'a2a',
            payload: fields.payload,
            recipients: new Map([
              [linkReplicaId(fields.to.signPub), fields.to.sealPub],
            ]),
          });
    return buildOp(
      {
        replica: this.replica,
        seq,
        prev: after === null ? ZERO_HASH : opHash(after),
        hlc: this.hlc(seq, fields.hlcMs),
        type,
        ...(fields.body === undefined ? {} : { body: fields.body }),
        ...(sealed === undefined
          ? {}
          : { to: sealed.to, sealed: sealed.sealed }),
      },
      this.keys.signPriv
    );
  }

  async write(...ops: FederatedOp[]): Promise<void> {
    await this.repo.ensure();
    await this.repo.exchange();
    await this.repo.writeV2(ops);
    this.ops.push(...ops);
    await this.repo.exchange();
  }
}
