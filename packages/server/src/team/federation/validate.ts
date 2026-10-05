import { TASK_ID_PATTERN } from '@dispatch-foo/core';
import { parseAddress } from '@dispatch-foo/protocol';
import type { Address, Message } from '@dispatch-foo/protocol';
import { REPLICA_ID } from '@dispatch-foo/protocol/federation';
import type {
  AgentBody,
  ChannelBody,
  ForwardPayload,
  MailPayload,
  MailTarget,
  PresenceBody,
  StatePayload,
} from '@dispatch-foo/protocol/federation';

import { readCaps } from './caps.js';
import type { FedStore } from './store.js';

// FW-R32(3): every F2 op body is read field by field here, and a body that
// is not exactly what an honest build writes is refused. These never throw.

const MAX_TEXT = 256;
const DELIVERY_STATES = ['held', 'pushed', 'notified', 'read', 'answered'];

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max = MAX_TEXT): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;

/** An address of an allowed kind, or false. */
function isAddress(
  v: unknown,
  kinds: readonly string[] = ['human', 'agent', 'task', 'run', 'channel']
): v is Address {
  if (typeof v !== 'string') return false;
  try {
    return kinds.includes(parseAddress(v).kind);
  } catch {
    return false;
  }
}

export const isReplica = (v: unknown): v is string =>
  typeof v === 'string' && REPLICA_ID.test(v);
const isRunId = (v: unknown): v is string =>
  typeof v === 'string' && isAddress(`run:${v}`, ['run']);
const isChannelName = (v: unknown): v is string =>
  typeof v === 'string' && isAddress(`channel:${v}`, ['channel']);

export function presenceBody(v: unknown): PresenceBody | null {
  if (!isObj(v)) return null;
  if (v['kind'] === 'replica') {
    if (
      !text(v['build']) ||
      !text(v['device']) ||
      typeof v['wall'] !== 'number' ||
      !Number.isFinite(v['wall'])
    )
      return null;
    const base = {
      kind: 'replica' as const,
      build: v['build'],
      device: v['device'],
      wall: v['wall'],
    };
    if (v['caps'] === undefined) return base;
    // FW-R39: a re-announcement of what the build speaks.
    const caps = readCaps(v['caps']);
    return caps === null ? null : { ...base, caps };
  }
  if (v['kind'] === 'run') {
    const task = v['task'];
    const waiting = v['waitingOn'];
    if (
      !isRunId(v['run']) ||
      !(
        task === null ||
        (typeof task === 'string' && TASK_ID_PATTERN.test(task))
      ) ||
      !text(v['runKind'], 32) ||
      typeof v['live'] !== 'boolean' ||
      !(waiting === undefined || text(waiting, 128))
    )
      return null;
    return {
      kind: 'run',
      run: v['run'],
      task,
      runKind: v['runKind'],
      live: v['live'],
      ...(waiting === undefined ? {} : { waitingOn: waiting }),
    };
  }
  if (v['kind'] === 'resolve')
    return isRunId(v['run']) && isReplica(v['replica'])
      ? { kind: 'resolve', run: v['run'], replica: v['replica'] }
      : null;
  return null;
}

export function agentBody(v: unknown): AgentBody | null {
  if (!isObj(v)) return null;
  const status = v['status'];
  if (
    !isAddress(v['address'], ['agent']) ||
    !text(v['displayName']) ||
    !text(v['client'], 128) ||
    !(status === 'pending' || status === 'approved' || status === 'revoked')
  )
    return null;
  return {
    address: v['address'],
    displayName: v['displayName'],
    client: v['client'],
    status,
  };
}

export function channelBody(v: unknown): ChannelBody | null {
  if (!isObj(v)) return null;
  if (
    !isChannelName(v['channel']) ||
    !isAddress(v['member'], ['human', 'agent', 'task']) ||
    typeof v['joined'] !== 'boolean'
  )
    return null;
  return { channel: v['channel'], member: v['member'], joined: v['joined'] };
}

function target(v: unknown): MailTarget | null {
  if (!isObj(v)) return null;
  const homes = v['homes'];
  const wakeAt = v['wakeAt'];
  if (
    !isAddress(v['recipient']) ||
    !(v['via'] === 'direct' || v['via'] === 'channel') ||
    !Array.isArray(homes) ||
    !homes.every(isReplica) ||
    !(wakeAt === undefined || isReplica(wakeAt))
  )
    return null;
  return {
    recipient: v['recipient'],
    via: v['via'],
    homes,
    ...(wakeAt === undefined ? {} : { wakeAt }),
  };
}

/** A mail payload whose message carries the fields receive reads first;
 *  the engine checks the rest of the envelope. */
export function mailPayload(v: unknown): MailPayload | null {
  if (!isObj(v) || !isObj(v['message']) || !Array.isArray(v['targets']))
    return null;
  const m = v['message'];
  if (
    !text(m['id'], 64) ||
    !isAddress(m['from'], ['human', 'agent', 'run']) ||
    !text(m['hlc'], 96)
  )
    return null;
  const targets = v['targets'].map(target);
  if (targets.some((t) => t === null)) return null;
  return {
    message: m as unknown as Message,
    targets: targets as MailTarget[],
  };
}

export function forwardPayload(v: unknown): ForwardPayload | null {
  if (!isObj(v) || !isAddress(v['target']) || !text(v['key'], 128)) return null;
  return { target: v['target'], key: v['key'] };
}

export function statePayload(v: unknown): StatePayload | null {
  if (!isObj(v) || !Array.isArray(v['entries'])) return null;
  const entries: StatePayload['entries'] = [];
  for (const e of v['entries']) {
    if (
      !isObj(e) ||
      !text(e['message'] ?? e['question'], 64) ||
      !text(e['at'], 64)
    )
      return null;
    if (e['t'] === 'delivery') {
      if (
        !isAddress(e['recipient']) ||
        !DELIVERY_STATES.includes(String(e['state']))
      )
        return null;
      entries.push(e as unknown as StatePayload['entries'][number]);
    } else if (e['t'] === 'refused') {
      if (!text(e['reason'], 8192)) return null;
      entries.push(e as unknown as StatePayload['entries'][number]);
    } else if (e['t'] === 'settle') {
      const closed = e['closed'];
      if (!text(e['question'], 64) || !text(e['answer'], 64)) return null;
      if (!(closed === undefined || text(closed, 8192))) return null;
      entries.push(e as unknown as StatePayload['entries'][number]);
    } else return null;
  }
  return { entries };
}

/** FW-R32(3)(6): one rolling note a person can acknowledge per publisher and kind. */
export function dropNote(
  fed: FedStore,
  kind: 'malformed' | 'mail-drop' | 'memory-cap' | 'memory-quota',
  replica: string,
  message: string
): void {
  fed.problem(`${kind}:${replica}`, message);
}
