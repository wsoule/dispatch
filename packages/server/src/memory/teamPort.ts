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
  ProposalContent,
} from '@dispatch/memory';
import { SYSTEM_ADDRESS } from '@dispatch/protocol';
import type { Address, Ref } from '@dispatch/protocol';

import type { TeamMemoryPort } from '../team/federation/memory.js';

// Revisions that never travel: decay is local, and sync came from the team.
const LOCAL_ONLY = new Set(['decay', 'sync']);
// How far back `unpublished` looks for local changes still to send.
const UNPUBLISHED_SCAN = 5000;

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

/**
 * Federation's view of memory v1 (federation F3): which team entries changed
 * locally, and how an entry the team merged is written here, as an entry or,
 * when this daemon's policy would block a policy-approved one, a proposal.
 */
export function createTeamMemoryPort(deps: {
  engine: MemoryEngine;
  shared: MemoryStore;
  host: MemoryHost;
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

  return {
    teamEntries: () => shared.listEntries({ scopes: ['team'] }),

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
      const entries: MemoryEntry[] = [];
      for (const id of ids) {
        const entry = shared.getEntry(id);
        if (entry !== null && entry.scope === 'team') entries.push(entry);
      }
      return { entries, through: marks.at(-1)?.rowid ?? sinceRev };
    },

    unpublished: (sinceRev) =>
      new Set(
        shared
          .revisionsSince(sinceRev, UNPUBLISHED_SCAN)
          .filter((m) => !LOCAL_ONLY.has(m.cause))
          .map((m) => m.memoryId)
      ),

    heldTrust: (id) => shared.getEntry(id)?.trust ?? null,

    applyRemote: ({ id, fields, trust, replica }) => {
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
      const now = host.now().toISOString();
      const held = shared.getEntry(id);
      if (held !== null) {
        if (held.scope !== 'team') return 'ignored';
        const next: MemoryEntry = {
          ...held,
          ...content,
          ...extra,
          author,
          trust,
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
      const tried = attempts(replica, id);
      const last = tried.at(-1);
      if (last?.state === 'open') {
        engine.reviseSyncedProposal(last.id, content);
        return 'proposal';
      }
      // Decided here already: a rejected entry comes back only changed.
      if (
        last !== undefined &&
        (last.state === 'approved' ||
          last.contentHash === memoryContentHash(content))
      )
        return 'ignored';
      if (extra.decidedByPolicy !== null && extra.status === 'active') {
        const out = engine.proposeSynced({
          id,
          origin: syncOrigin(replica, id, tried.length + 1),
          author,
          content,
        });
        if (out.status === 'proposed') return 'proposal';
        if (out.status === 'duplicate') return 'ignored';
      }
      const entry: MemoryEntry = {
        ...newMemoryEntry(
          { ...content, scope: 'team', author, trust },
          id,
          now
        ),
        ...extra,
        updatedAt: now,
      };
      // A 40-bit handle another entry here already holds: left out.
      if (shared.entriesByHandle(memoryHandle(id)).length > 0) return 'ignored';
      shared.insertEntry(entry, SYSTEM_ADDRESS, 'sync');
      host.changed({ scope: 'team', id });
      if (
        displayState(entry) === 'active' &&
        (entry.kind === 'hazard' || entry.kind === 'constraint')
      )
        host.entryActivated(entry, null);
      return 'entry';
    },
  };
}
