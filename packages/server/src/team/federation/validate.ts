import {
  DOC_STATUSES,
  docBodyProblem,
  DOCS_LIMITS,
  docSlugProblem,
  docTitleProblem,
  LINK_RELS,
  LINK_TARGET_TYPES,
  TASK_ID_PATTERN,
} from '@dispatch/core';
import type { RevisionCause } from '@dispatch/core';
import { parseAddress } from '@dispatch/protocol';
import type { Address, Message } from '@dispatch/protocol';
import { REPLICA_ID } from '@dispatch/protocol/federation';
import type {
  AgentBody,
  ChannelBody,
  DocBody,
  ForwardPayload,
  MailPayload,
  MailTarget,
  PresenceBody,
  StatePayload,
} from '@dispatch/protocol/federation';

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
  if (v['kind'] === 'replica')
    return text(v['build']) &&
      text(v['device']) &&
      typeof v['wall'] === 'number' &&
      Number.isFinite(v['wall'])
      ? {
          kind: 'replica',
          build: v['build'],
          device: v['device'],
          wall: v['wall'],
        }
      : null;
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
  kind: 'malformed' | 'mail-drop',
  replica: string,
  message: string
): void {
  fed.problem(`${kind}:${replica}`, message);
}

const DOC_ID = /^doc-[0-9A-Z]{26}$/;
const REV_ID = /^rev-[0-9A-Z]{26}$/;
const HASH = /^[0-9a-f]{64}$/;
const CAUSES: readonly RevisionCause[] = [
  'create',
  'save',
  'edit',
  'merge',
  'revert',
  'import',
  'restore',
  'proposal',
  'approve',
  'reject',
  'sync',
];
/** The most parents one revision names: a merge, approve or reject has two. */
const MAX_PARENTS = 16;
const MAX_LINK_ID = 128;
const utf8 = (v: string): number => Buffer.byteLength(v);

// Doc authors are historical: any run id an older build minted still names one.
const DOC_AUTHOR = /^(?:human|agent|run):[A-Za-z0-9._/@:-]{1,128}$/;
const isDocAuthor = (v: unknown): v is Address =>
  typeof v === 'string' && DOC_AUTHOR.test(v);
// A proposal's source task id, as any build named it.
const DOC_TASK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const isRevId = (v: unknown): v is string =>
  typeof v === 'string' && REV_ID.test(v);
const isIso = (v: unknown): v is string =>
  text(v, 64) && !Number.isNaN(Date.parse(v));

function docRevision(v: unknown): DocBody['revision'] | null {
  if (!isObj(v)) return null;
  const { parents, approval, task } = v;
  if (
    !isRevId(v['id']) ||
    !Array.isArray(parents) ||
    parents.length > MAX_PARENTS ||
    !parents.every(isRevId) ||
    docTitleProblem(v['title']) !== null ||
    docBodyProblem(v['body']) !== null ||
    typeof v['hash'] !== 'string' ||
    !HASH.test(v['hash']) ||
    !isDocAuthor(v['author']) ||
    !CAUSES.includes(v['cause'] as RevisionCause) ||
    typeof v['summary'] !== 'string' ||
    utf8(v['summary']) > DOCS_LIMITS.summaryBytes ||
    !isIso(v['createdAt']) ||
    !(task === undefined || (typeof task === 'string' && DOC_TASK.test(task)))
  )
    return null;
  let checked: { by: Address; policy?: { rung: number } } | undefined;
  if (approval !== undefined) {
    if (!isObj(approval) || !isDocAuthor(approval['by'])) return null;
    const policy = approval['policy'];
    if (
      policy !== undefined &&
      !(
        isObj(policy) &&
        Number.isSafeInteger(policy['rung']) &&
        (policy['rung'] as number) >= 0 &&
        (policy['rung'] as number) <= 10
      )
    )
      return null;
    checked = {
      by: approval['by'],
      ...(policy === undefined
        ? {}
        : { policy: { rung: policy['rung'] as number } }),
    };
  }
  return {
    id: v['id'],
    parents,
    title: v['title'] as string,
    body: v['body'] as string,
    hash: v['hash'],
    author: v['author'],
    cause: v['cause'] as RevisionCause,
    summary: v['summary'],
    createdAt: v['createdAt'],
    ...(checked === undefined ? {} : { approval: checked }),
    ...(task === undefined ? {} : { task }),
  };
}

function docMeta(v: unknown): DocBody['meta'] | null {
  if (!isObj(v)) return null;
  const { slug, aliases, title, status, links } = v;
  if (slug !== undefined && docSlugProblem(slug) !== null) return null;
  if (
    aliases !== undefined &&
    !(
      Array.isArray(aliases) &&
      aliases.length <= DOCS_LIMITS.linksPerDoc &&
      aliases.every((a) => docSlugProblem(a) === null)
    )
  )
    return null;
  if (title !== undefined && docTitleProblem(title) !== null) return null;
  if (status !== undefined && !DOC_STATUSES.includes(status as never))
    return null;
  let checkedLinks: NonNullable<DocBody['meta']>['links'];
  if (links !== undefined) {
    if (!Array.isArray(links) || links.length > DOCS_LIMITS.linksPerDoc)
      return null;
    checkedLinks = [];
    for (const l of links) {
      if (!isObj(l) || !isObj(l['target'])) return null;
      const { type, id } = l['target'];
      if (
        !LINK_TARGET_TYPES.includes(type as never) ||
        !text(id, MAX_LINK_ID) ||
        !LINK_RELS.includes(l['rel'] as never)
      )
        return null;
      checkedLinks.push({
        target: { type: type as never, id },
        rel: l['rel'] as never,
      });
    }
  }
  return {
    ...(slug === undefined ? {} : { slug: slug as string }),
    ...(aliases === undefined ? {} : { aliases: aliases as string[] }),
    ...(title === undefined ? {} : { title: title as string }),
    ...(status === undefined ? {} : { status: status as never }),
    ...(checkedLinks === undefined ? {} : { links: checkedLinks }),
  };
}

/** A doc op body exactly as an honest build writes it, within the docs
 *  limits a producer enforces, or null. */
export function docBody(v: unknown): DocBody | null {
  if (!isObj(v)) return null;
  const { doc, kind, by, revision, meta, review } = v;
  if (
    typeof doc !== 'string' ||
    !DOC_ID.test(doc) ||
    !(kind === 'put' || kind === 'remove') ||
    !isDocAuthor(by)
  )
    return null;
  const rev = revision === undefined ? undefined : docRevision(revision);
  const m = meta === undefined ? undefined : docMeta(meta);
  if (rev === null || m === null) return null;
  if (review !== undefined && !(isObj(review) && isRevId(review['rev'])))
    return null;
  if (kind === 'remove' && (rev !== undefined || m !== undefined)) return null;
  return {
    doc,
    kind,
    by,
    ...(rev === undefined ? {} : { revision: rev }),
    ...(m === undefined ? {} : { meta: m }),
    ...(review === undefined
      ? {}
      : { review: { rev: review['rev'] as string } }),
  };
}
