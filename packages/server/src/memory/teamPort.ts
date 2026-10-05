import {
  displayState,
  memoryContentHash,
  MemoryError,
  memoryHandle,
  newMemoryEntry,
  syncOrigin,
  validateMemoryInput,
} from '@dispatch/memory';
import type {
  MemoryEngine,
  MemoryEntry,
  MemoryHost,
  MemoryProposal,
  MemoryStore,
  MemoryTrust,
  ProposalContent,
} from '@dispatch/memory';
import { SYSTEM_ADDRESS } from '@dispatch/protocol';
import type { Address, Ref } from '@dispatch/protocol';

import type {
  ApplyOutcome,
  TeamChange,
  TeamMemoryPort,
} from '../team/federation/memory.js';

// Revisions that never travel: decay is local, and sync came from the team.
const LOCAL_ONLY = new Set(['decay', 'sync']);
// How far back `unpublished` looks for local changes still to send.
const UNPUBLISHED_SCAN = 5000;
// FW-R37(3): sync proposals one publisher may have open here.
const OPEN_PER_PUBLISHER = 50;

// The entry fields a merged remote entry sets, beyond its content.
type Extra = Pick<
  MemoryEntry,
  | 'pinned'
  | 'status'
  | 'statusReason'
  | 'supersedes'
  | 'supersededBy'
  | 'createdAt'
  | 'decidedBy'
  | 'decidedByPolicy'
>;

// What a gated change sets besides content, said for the gate and compared
// to tell whether an approval still covers it.
function describe(extra: Extra): string {
  const parts = [`status ${extra.status}`];
  if (extra.statusReason !== null) parts.push(`(${extra.statusReason})`);
  if (extra.pinned) parts.push('pinned');
  if (extra.supersedes !== null) parts.push(`supersedes ${extra.supersedes}`);
  return `From a teammate's machine: ${parts.join(', ')}`;
}

/**
 * Federation's view of memory v1 (federation F3): which team entries changed
 * locally, and how an entry the team merged is written here, directly when
 * a human the publisher speaks for backs it, else through local policy.
 */
export function createTeamMemoryPort(deps: {
  engine: MemoryEngine;
  shared: MemoryStore;
  host: MemoryHost;
  /** Sync proposals one publisher may have open here. */
  maxOpenPerPublisher?: number;
}): TeamMemoryPort {
  const { engine, shared, host } = deps;

  // The proposals a replicated entry has had here, oldest attempt first.
  const attempts = (replica: string, id: string): MemoryProposal[] => {
    const out: MemoryProposal[] = [];
    for (let n = 1; ; n++) {
      const p = shared.proposalByOrigin(syncOrigin(replica, id, n));
      if (p === null) return out;
      out.push(p);
    }
  };

  // Who made an entry's latest change that travels.
  const changeOf = (entry: MemoryEntry): TeamChange => {
    const last = shared
      .revisions(entry.id)
      .filter((r) => !LOCAL_ONLY.has(r.cause))
      .at(-1);
    return { entry, by: last?.by ?? entry.author };
  };

  // The merged entry written as it stands; a new one keeps its id.
  const write = (
    id: string,
    content: ProposalContent,
    extra: Extra,
    author: Address,
    trust: MemoryTrust
  ): ApplyOutcome => {
    const now = host.now().toISOString();
    const held = shared.getEntry(id);
    if (held !== null) {
      // Q10: a change that leaves the content alone never lowers trust.
      const kept =
        memoryContentHash(held) === memoryContentHash(content) &&
        RANK[held.trust] > RANK[trust]
          ? held.trust
          : trust;
      const next: MemoryEntry = {
        ...held,
        ...content,
        ...extra,
        author,
        trust: kept,
      };
      if (JSON.stringify(next) === JSON.stringify(held)) return 'entry';
      shared.updateEntry(
        { ...next, rev: held.rev + 1, updatedAt: now },
        SYSTEM_ADDRESS,
        'sync',
        now
      );
      host.changed({ scope: 'team', id });
      return 'entry';
    }
    // A 40-bit handle another entry here already holds.
    if (shared.entriesByHandle(memoryHandle(id)).length > 0) return 'collision';
    const entry: MemoryEntry = {
      ...newMemoryEntry({ ...content, scope: 'team', author, trust }, id, now),
      ...extra,
      updatedAt: now,
    };
    shared.insertEntry(entry, SYSTEM_ADDRESS, 'sync');
    host.changed({ scope: 'team', id });
    if (
      displayState(entry) === 'active' &&
      (entry.kind === 'hazard' || entry.kind === 'constraint')
    )
      host.entryActivated(entry, null);
    return 'entry';
  };

  return {
    teamEntries: () =>
      shared.listEntries({ scopes: ['team'] }).map((e) => changeOf(e)),

    latestRev: () => {
      let last = 0;
      for (;;) {
        const marks = shared.revisionsSince(last, 1000);
        if (marks.length === 0) return last;
        last = marks.at(-1)?.rowid ?? last;
      }
    },

    changedTeamEntries: (sinceRev, limit) => {
      const marks = shared.revisionsSince(sinceRev, limit);
      const ids = new Set(
        marks.filter((m) => !LOCAL_ONLY.has(m.cause)).map((m) => m.memoryId)
      );
      const changes: TeamChange[] = [];
      for (const id of ids) {
        const entry = shared.getEntry(id);
        if (entry !== null && entry.scope === 'team')
          changes.push(changeOf(entry));
      }
      return { changes, through: marks.at(-1)?.rowid ?? sinceRev };
    },

    unpublished: (sinceRev) =>
      new Set(
        shared
          .revisionsSince(sinceRev, UNPUBLISHED_SCAN)
          .filter((m) => !LOCAL_ONLY.has(m.cause))
          .map((m) => m.memoryId)
      ),

    heldTrust: (id) => shared.getEntry(id)?.trust ?? null,

    applyRemote: ({ id, fields, trust, replica, backed }) => {
      const author = fields.author as Address | undefined;
      if (author === undefined) return 'invalid';
      let content: ProposalContent;
      try {
        const valid = validateMemoryInput({
          scope: 'team',
          kind: fields.kind as MemoryEntry['kind'],
          title: fields.title as string,
          body: fields.body as string,
          refs: fields.refs as Ref[],
          epic: (fields.epic ?? null) as string | null,
          appliesTo: (fields.appliesTo ?? []) as string[],
          projectKey: null,
        });
        content = {
          kind: valid.kind,
          title: valid.title,
          body: valid.body,
          refs: valid.refs,
          epic: valid.epic,
          appliesTo: valid.appliesTo,
        };
      } catch (err) {
        if (err instanceof MemoryError) return 'invalid';
        throw err;
      }
      const extra: Extra = {
        pinned: fields.pinned === true,
        status: fields.status === 'retired' ? 'retired' : 'active',
        statusReason: (fields.statusReason ??
          null) as MemoryEntry['statusReason'],
        supersedes: (fields.supersedes ?? null) as string | null,
        supersededBy: (fields.supersededBy ?? null) as string | null,
        createdAt: (fields.createdAt ?? host.now().toISOString()) as string,
        decidedBy: (fields.decidedBy ?? null) as Address | null,
        decidedByPolicy: (fields.decidedByPolicy ??
          null) as MemoryEntry['decidedByPolicy'],
      };
      const held = shared.getEntry(id);
      if (held !== null && held.scope !== 'team') return 'ignored';
      const tried = attempts(replica, id);
      const last = tried.at(-1);
      const reason = describe(extra);
      const covers = (p: MemoryProposal) =>
        p.contentHash === memoryContentHash(content) && p.reason === reason;
      // What a gate would decide: a new entry, or a change to content or to
      // its status, pin or supersession.
      const gated =
        held === null ||
        memoryContentHash(held) !== memoryContentHash(content) ||
        JSON.stringify([held.epic, held.appliesTo]) !==
          JSON.stringify([content.epic, content.appliesTo]) ||
        reason !== describe({ ...extra, ...pickExtra(held) });
      // A proposal still open is what a human here was asked; it is updated
      // rather than bypassed.
      if (last?.state === 'open') {
        if (!covers(last))
          engine.reviseSyncedProposal(last.id, content, reason);
        return 'proposal';
      }
      if (!gated || backed) return write(id, content, extra, author, trust);
      if (last?.state === 'approved' && covers(last))
        return write(
          id,
          content,
          extra,
          author,
          RANK[trust] >= RANK.confirmed ? trust : 'confirmed'
        );
      // Decided here already: it comes back only changed.
      if (last !== undefined && covers(last)) return 'ignored';
      const cap = deps.maxOpenPerPublisher ?? OPEN_PER_PUBLISHER;
      const open = shared
        .listProposals({ states: ['open'] })
        .filter((p) => p.origin?.startsWith(`sync:${replica}:`) === true);
      if (open.length >= cap) return 'capped';
      const out = engine.proposeSynced({
        id,
        origin: syncOrigin(replica, id, tried.length + 1),
        author,
        content,
        target: held?.id ?? null,
        reason,
      });
      if (out.status === 'proposed') return 'proposal';
      if (out.status === 'duplicate') return 'ignored';
      return write(id, content, extra, author, trust);
    },
  };
}

const RANK: Record<MemoryTrust, number> = { agent: 0, confirmed: 1, human: 2 };

// The status, pin and supersession fields `describe` reads.
function pickExtra(
  e: MemoryEntry
): Pick<Extra, 'status' | 'statusReason' | 'pinned' | 'supersedes'> {
  return {
    status: e.status,
    statusReason: e.statusReason,
    pinned: e.pinned,
    supersedes: e.supersedes,
  };
}
