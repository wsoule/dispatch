import { CANONICAL_STATUSES, canonicalStatus } from '@dispatch-foo/core';

// Where a task sits in a handoff's life, whatever the project calls the status.
export type HandoffPhase =
  | 'draft'
  | 'queued'
  | 'working'
  | 'review'
  | 'landing'
  | 'landed'
  | 'dropped';

// Linear's workflow-state types, the kinds a project's statuses are typed by.
export type StatusKind =
  | 'triage'
  | 'backlog'
  | 'unstarted'
  | 'started'
  | 'completed'
  | 'canceled';

// A project's typed statuses plus those written on each lifecycle event;
// shaped like core's StatusModel so a host can pass one straight in.
export interface StatusVocabulary {
  definitions: readonly { name: string; type: StatusKind }[];
  roles: {
    ready: string | null;
    review: string | null;
    landing: string | null;
    landed: string | null;
    dropped: string | null;
  };
}

// How the handoff code reads and writes a project's statuses: each status's
// phase, and the names it writes (null when the project has none).
export interface HandoffStatuses {
  phase(status: string): HandoffPhase;
  draft: string | null;
  ready: string | null;
  landed: string | null;
  dropped: string | null;
}

// A vocabulary that can carry a handoff from draft to landed or dropped.
export type SupportedHandoffStatuses = HandoffStatuses & {
  draft: string;
  ready: string;
  landed: string;
  dropped: string;
};

const BUILT_IN_KINDS: Record<string, StatusKind> = {
  draft: 'backlog',
  ready: 'unstarted',
  working: 'started',
  review: 'started',
  landing: 'started',
  landed: 'completed',
  dropped: 'canceled',
};

// Classifies statuses by type and role, never name; a new draft goes to the
// first backlog status (triage when there is none).
export function handoffStatuses(v: StatusVocabulary): HandoffStatuses {
  const kinds = new Map(v.definitions.map((d) => [d.name, d.type]));
  const firstOf = (type: StatusKind) =>
    v.definitions.find((d) => d.type === type)?.name ?? null;
  return {
    phase(status) {
      const name = canonicalStatus(status);
      const kind = kinds.get(name) ?? BUILT_IN_KINDS[name] ?? 'backlog';
      switch (kind) {
        case 'triage':
        case 'backlog':
          return 'draft';
        case 'unstarted':
          return 'queued';
        case 'started':
          if (name === v.roles.review) return 'review';
          if (name === v.roles.landing) return 'landing';
          return 'working';
        case 'completed':
          return 'landed';
        case 'canceled':
          return 'dropped';
      }
    },
    draft: firstOf('backlog') ?? firstOf('triage'),
    ready: v.roles.ready,
    landed: v.roles.landed,
    dropped: v.roles.dropped,
  };
}

// The vocabulary of a config that lists names only: built-ins keep their
// types and roles, and a custom name counts as work in progress.
export function namedStatusVocabulary(
  names: readonly string[]
): StatusVocabulary {
  const have = new Set(names.map(canonicalStatus));
  const role = (name: string) => (have.has(name) ? name : null);
  return {
    definitions: [...have].map((name) => ({
      name,
      type: BUILT_IN_KINDS[name] ?? 'started',
    })),
    roles: {
      ready: role('ready'),
      review: role('review'),
      landing: role('landing'),
      landed: role('landed'),
      dropped: role('dropped'),
    },
  };
}

export const DEFAULT_HANDOFF_STATUSES: HandoffStatuses = handoffStatuses(
  namedStatusVocabulary(CANONICAL_STATUSES)
);

// A handoff needs somewhere to draft, approve, land and drop its task.
export function handoffSupported(
  s: HandoffStatuses
): s is SupportedHandoffStatuses {
  return (
    s.draft !== null &&
    s.ready !== null &&
    s.landed !== null &&
    s.dropped !== null
  );
}
