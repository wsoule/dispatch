# Team Identity and Merge Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Dispatch board able to name _which_ human or agent did
something, and survive two people writing to it concurrently.

**Architecture:** `assignee` widens from a closed three-value union to a parsed
actor reference (`human:wyat`, `agent:wyat/claude`), with the legacy values
still valid so no task file needs migrating. A committed `.dispatch/team.yml`
roster self-registers each developer from their git identity. Every mutation —
Activity lines, findings, ledger entries, review comments — records the acting
actor. A task-file merge driver unions the Activity log and merges frontmatter
field-by-field so concurrent edits stop conflicting, and the inbox partitions
per actor so it cannot conflict at all.

**Tech Stack:** Bun + TypeScript monorepo, `bun test`, oxlint/oxfmt, `yaml`
package (already a core dependency, see `packages/core/src/config.ts`).

**Spec:** `docs/superpowers/specs/2026-08-02-team-collaboration-design.md` —
this plan covers §8 build-order steps 1 and 2 (§4.1, §4.2, §4.3, §4.6, §4.7).
Steps 3–6 (board syncer, presence/claims, cross-machine agents, audit and
surfaces) get their own plans.

## Global Constraints

- Run everything from the worktree root
  `/Users/wyatsoule/Sites/dispatch-worktrees/team-impl` (branch
  `feat/team-collaboration`, based on `main` @`0b6ce89`).
- `export AGENT=1` at the start of every terminal session.
- Use `bun`. Never `npm`, `pnpm`, or `npx`.
- Dependencies come from the root `workspaces.catalog`. Do not add versions to
  package-level `package.json` files.
- Code comments are 1–2 lines maximum. Prefer one function-level comment saying
  what the helper does and why it exists over many inline comments. No incident
  narratives.
- Preserve trailing newlines at the end of files.
- Anything added to `packages/core/src/` that the desktop webview needs must be
  free of `node:*` imports and exported from `packages/core/src/browser.ts`.
- After each task: `bun run format` and `bun run lint` from the worktree root,
  plus `bun ws core tsc` (or the relevant package) and the focused tests.
- `bun run lint` inherits a red baseline from `main` (errors in
  `apps/desktop/**` and `packages/web/**`). Only treat _new_ errors in files
  this plan touches as failures.
- `bun run tsc` carries 4 pre-existing `PlanRecord.role` errors in
  `apps/desktop`. Same rule: only new ones count.
- **`bun test packages/server/test/` takes ~237s and exceeds the default 120s
  tool timeout.** Run it with an explicit timeout of 400000 ms, or it is
  auto-backgrounded and the run appears to hang. `bun test packages/core/test/`
  is sub-second and needs no special handling.
- **The pre-commit hook runs `oxlint --type-aware --fix`, which rewrites `||`
  into `??` via `typescript/prefer-nullish-coalescing` — during the commit,
  silently.** It has already reintroduced one fixed bug this way. Where an empty
  string must fall back, do not write `||`: use an explicit comparison or a
  named helper, and re-check the file after committing.

---

### Task 1: Actor reference model

**Files:**

- Create: `packages/core/src/actor.ts`
- Create: `packages/core/test/actor.test.ts`
- Modify: `packages/core/src/browser.ts` (add the export)
- Modify: `packages/core/src/index.ts` (add the export)

**Interfaces:**

- Consumes: nothing.
- Produces: `type ActorKind = 'human' | 'agent'`;
  `interface ActorRef { kind: ActorKind; handle: string | null; operator: string | null }`;
  `class ActorRefError extends Error`;
  `parseActorRef(raw: string): ActorRef | null` (returns `null` for `'none'`,
  throws `ActorRefError` when malformed);
  `formatActorRef(ref: ActorRef | null): string`;
  `isValidAssignee(raw: string): boolean`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/actor.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';

import {
  ActorRefError,
  formatActorRef,
  isValidAssignee,
  parseActorRef,
} from '../src/actor.js';

describe('parseActorRef', () => {
  it('returns null for the unassigned value', () => {
    expect(parseActorRef('none')).toBeNull();
  });

  it('parses the legacy unspecified values', () => {
    expect(parseActorRef('human')).toEqual({
      kind: 'human',
      handle: null,
      operator: null,
    });
    expect(parseActorRef('agent')).toEqual({
      kind: 'agent',
      handle: null,
      operator: null,
    });
  });

  it('parses a named human', () => {
    expect(parseActorRef('human:wyat')).toEqual({
      kind: 'human',
      handle: 'wyat',
      operator: null,
    });
  });

  it('parses an operator-scoped agent', () => {
    expect(parseActorRef('agent:wyat/claude')).toEqual({
      kind: 'agent',
      handle: 'claude',
      operator: 'wyat',
    });
  });

  it('parses a standing agent with no operator', () => {
    expect(parseActorRef('agent:reviewer')).toEqual({
      kind: 'agent',
      handle: 'reviewer',
      operator: null,
    });
  });

  it('rejects an unknown kind', () => {
    expect(() => parseActorRef('robot:x')).toThrow(ActorRefError);
  });

  it('rejects a handle with illegal characters', () => {
    expect(() => parseActorRef('human:Wyat Soule')).toThrow(ActorRefError);
  });

  it('rejects an empty handle', () => {
    expect(() => parseActorRef('human:')).toThrow(ActorRefError);
  });

  it('rejects a human with an operator segment', () => {
    expect(() => parseActorRef('human:a/b')).toThrow(ActorRefError);
  });
});

describe('formatActorRef', () => {
  it('round-trips every valid form', () => {
    for (const raw of [
      'none',
      'human',
      'agent',
      'human:wyat',
      'agent:reviewer',
      'agent:wyat/claude',
    ]) {
      expect(formatActorRef(parseActorRef(raw))).toBe(raw);
    }
  });
});

describe('isValidAssignee', () => {
  it('accepts valid forms and rejects malformed ones', () => {
    expect(isValidAssignee('agent:wyat/claude')).toBe(true);
    expect(isValidAssignee('none')).toBe(true);
    expect(isValidAssignee('robot:x')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/actor.test.ts` Expected: FAIL — cannot resolve
`../src/actor.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/actor.ts`:

```ts
// Pure data shapes, no node:* imports, so this is safe for the desktop
// webview via the '@dispatch/core/browser' entry point.

export type ActorKind = 'human' | 'agent';

export interface ActorRef {
  kind: ActorKind;
  /** Stable handle within the project; null means "any actor of this kind". */
  handle: string | null;
  /** For agents, the handle of the human who owns it; null otherwise. */
  operator: string | null;
}

export class ActorRefError extends Error {}

/** The unassigned wire value, kept distinct from a malformed one. */
export const UNASSIGNED = 'none';

const HANDLE = /^[a-z0-9][a-z0-9._-]*$/;

function requireHandle(value: string, raw: string): string {
  if (!HANDLE.test(value)) {
    throw new ActorRefError(`invalid actor handle in: ${raw}`);
  }
  return value;
}

/**
 * Parses a task's `assignee` wire value. Returns null for `none`; the bare
 * `human`/`agent` legacy values parse as that kind with no handle, so existing
 * task files stay valid without migration.
 */
export function parseActorRef(raw: string): ActorRef | null {
  if (raw === UNASSIGNED) return null;
  const [kind, rest] = raw.includes(':')
    ? [raw.slice(0, raw.indexOf(':')), raw.slice(raw.indexOf(':') + 1)]
    : [raw, null];
  if (kind !== 'human' && kind !== 'agent') {
    throw new ActorRefError(`invalid actor kind: ${raw}`);
  }
  if (rest === null) return { kind, handle: null, operator: null };
  if (!rest.includes('/')) {
    return { kind, handle: requireHandle(rest, raw), operator: null };
  }
  if (kind === 'human') {
    throw new ActorRefError(`a human ref cannot carry an operator: ${raw}`);
  }
  const [operator, handle] = [
    rest.slice(0, rest.indexOf('/')),
    rest.slice(rest.indexOf('/') + 1),
  ];
  return {
    kind,
    handle: requireHandle(handle, raw),
    operator: requireHandle(operator, raw),
  };
}

export function formatActorRef(ref: ActorRef | null): string {
  if (ref === null) return UNASSIGNED;
  if (ref.handle === null) return ref.kind;
  if (ref.operator === null) return `${ref.kind}:${ref.handle}`;
  return `${ref.kind}:${ref.operator}/${ref.handle}`;
}

/** Validation gate for `assignee`, used where a throw would be the wrong shape. */
export function isValidAssignee(raw: string): boolean {
  try {
    parseActorRef(raw);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/test/actor.test.ts` Expected: PASS, 12 tests.

- [ ] **Step 5: Export from both entry points**

In `packages/core/src/browser.ts`, add after the `./conflicts.js` export line:

```ts
export {
  ActorRefError,
  formatActorRef,
  isValidAssignee,
  parseActorRef,
  UNASSIGNED,
} from './actor.js';
export type { ActorKind, ActorRef } from './actor.js';
```

In `packages/core/src/index.ts`, add the same names to the existing export
surface, matching the alphabetical style already used there.

- [ ] **Step 6: Verify and commit**

```bash
bun run format
bun ws core tsc
bun test packages/core/test/actor.test.ts
git add packages/core/src/actor.ts packages/core/test/actor.test.ts \
  packages/core/src/browser.ts packages/core/src/index.ts
git commit -m "feat(core): add the actor reference model

Task assignees can only say 'agent', 'human' or 'none' today, so a board
cannot record which teammate owns a task. Add a parsed actor reference
that widens the wire format to human:wyat and agent:wyat/claude while
keeping the bare legacy values valid, so no existing task file needs
migrating."
```

---

### Task 2: Widen the `assignee` validation gate

**Files:**

- Modify: `packages/core/src/types.ts` (the `Assignee` type)
- Modify: `packages/core/src/taskfile.ts:57` (the validation) and `:97`
- Test: `packages/core/test/taskfile.test.ts` (add cases)

**Interfaces:**

- Consumes: `isValidAssignee` from Task 1.
- Produces: `Assignee` is now `string`. `ASSIGNEES` stays exported unchanged as
  the legacy triple so existing pickers keep compiling.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/taskfile.test.ts`:

```ts
describe('assignee validation', () => {
  const frontmatter = (assignee: string) =>
    [
      '---',
      'id: t-abc123',
      'title: Example',
      'status: todo',
      'kind: task',
      'parent: null',
      'milestone: null',
      'blockedBy: []',
      'labels: []',
      'priority: none',
      `assignee: ${assignee}`,
      'created: 2026-08-02T00:00:00.000Z',
      'updated: 2026-08-02T00:00:00.000Z',
      'external: null',
      'selfReview: true',
      'writes: []',
      'risk: routine',
      'model: null',
      'exercised: false',
      '---',
      '',
      '## Description',
      '',
    ].join('\n');

  it('accepts a named actor', () => {
    const doc = parseTaskFile(frontmatter('human:wyat'), 'f.md');
    expect(doc.meta.assignee).toBe('human:wyat');
  });

  it('accepts an operator-scoped agent', () => {
    const doc = parseTaskFile(frontmatter('agent:wyat/claude'), 'f.md');
    expect(doc.meta.assignee).toBe('agent:wyat/claude');
  });

  it('still accepts the legacy values', () => {
    for (const legacy of ['agent', 'human', 'none']) {
      expect(parseTaskFile(frontmatter(legacy), 'f.md').meta.assignee).toBe(
        legacy
      );
    }
  });

  it('rejects a malformed actor', () => {
    expect(() => parseTaskFile(frontmatter('robot:x'), 'f.md')).toThrow(
      TaskParseError
    );
  });
});
```

If `parseTaskFile` or `TaskParseError` is not already imported in that file, add
it to the existing import from `../src/taskfile.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/taskfile.test.ts` Expected: FAIL —
`invalid assignee: human:wyat`, thrown by the `ASSIGNEES` check at
`taskfile.ts:57`.

- [ ] **Step 3: Widen the type**

In `packages/core/src/types.ts`, replace the `Assignee` line:

```ts
// A serialized ActorRef (see actor.ts): `none`, the legacy bare `human`/`agent`,
// or a named `human:wyat` / `agent:wyat/claude`.
export type Assignee = string;
```

Leave `ASSIGNEES` exactly as it is — it is the legacy triple the assignee
pickers still enumerate.

- [ ] **Step 4: Swap the validation**

In `packages/core/src/taskfile.ts`, add `isValidAssignee` to the imports from
`./actor.js`, then replace the check at line 57:

```ts
if (raw.assignee != null && !isValidAssignee(String(raw.assignee))) {
  throw new TaskParseError(`invalid assignee: ${String(raw.assignee)}`, file);
}
```

Remove `ASSIGNEES` from the `./types.js` import on line 11 if nothing else in
the file uses it.

- [ ] **Step 5: Run tests to verify they pass**

Run:
`bun test packages/core/test/taskfile.test.ts packages/core/test/store.test.ts`
Expected: PASS, no regressions.

- [ ] **Step 6: Verify the whole monorepo still typechecks**

Run: `bun run tsc` Expected: PASS. `Assignee` widening from a union to `string`
is permissive at every existing call site, so nothing should break. If
`apps/desktop` fails on an exhaustive `switch` over `Assignee`, add a `default`
branch rendering the value as-is — do not narrow the type back.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/taskfile.ts \
  packages/core/test/taskfile.test.ts
git commit -m "feat(core): accept named actors as a task assignee

Widen Assignee from the closed agent/human/none union to a serialized
actor reference and validate it through parseActorRef, so a task can
name a person or a specific agent. The bare legacy values stay valid,
so no task file on disk needs rewriting."
```

---

### Task 3: Team roster

**Files:**

- Create: `packages/core/src/team.ts`
- Create: `packages/core/test/team.test.ts`
- Modify: `packages/core/src/browser.ts`, `packages/core/src/index.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:
  `interface TeamMember { handle: string; email: string; displayName: string; emails: string[] }`;
  `parseTeam(yaml: string): TeamMember[]`;
  `serializeTeam(members: TeamMember[]): string`;
  `handleFromEmail(email: string, taken: Set<string>): string`;
  `upsertMember(members: TeamMember[], email: string, displayName: string, knownHandle?: string): { members: TeamMember[]; member: TeamMember; changed: boolean }`
  — matches by `knownHandle` first, then current-or-prior email. Never by
  display name.

This module is pure — no filesystem. File IO lives in the server (Task 4),
mirroring how `configTypes.ts` is pure and `config.ts` does the reading.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/team.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';

import {
  handleFromEmail,
  parseTeam,
  serializeTeam,
  upsertMember,
} from '../src/team.js';

describe('handleFromEmail', () => {
  it('uses the local part, lowercased', () => {
    expect(handleFromEmail('Wyat.Soule@example.com', new Set())).toBe(
      'wyat.soule'
    );
  });

  it('strips characters a handle cannot hold', () => {
    expect(handleFromEmail('a+tag@example.com', new Set())).toBe('atag');
  });

  it('suffixes on collision', () => {
    expect(handleFromEmail('wyat@a.com', new Set(['wyat']))).toBe('wyat2');
    expect(handleFromEmail('wyat@a.com', new Set(['wyat', 'wyat2']))).toBe(
      'wyat3'
    );
  });

  it('falls back when the local part yields nothing usable', () => {
    expect(handleFromEmail('+++@example.com', new Set())).toBe('member');
  });
});

describe('parseTeam / serializeTeam', () => {
  it('round-trips a roster', () => {
    const members = [
      {
        handle: 'wyat',
        email: 'w@example.com',
        displayName: 'Wyat Soule',
        emails: ['old@example.com'],
      },
    ];
    expect(parseTeam(serializeTeam(members))).toEqual(members);
  });

  it('treats an empty or absent file as an empty roster', () => {
    expect(parseTeam('')).toEqual([]);
    expect(parseTeam('members: []\n')).toEqual([]);
  });

  it('defaults a missing emails list', () => {
    const yaml =
      'members:\n  - handle: a\n    email: a@x.com\n    displayName: A\n';
    expect(parseTeam(yaml)[0]?.emails).toEqual([]);
  });
});

describe('upsertMember', () => {
  it('adds an unknown email as a new member', () => {
    const r = upsertMember([], 'w@example.com', 'Wyat');
    expect(r.changed).toBe(true);
    expect(r.member.handle).toBe('w');
    expect(r.members).toHaveLength(1);
  });

  it('is a no-op when the member is already present', () => {
    const first = upsertMember([], 'w@example.com', 'Wyat');
    const second = upsertMember(first.members, 'w@example.com', 'Wyat');
    expect(second.changed).toBe(false);
    expect(second.members).toHaveLength(1);
  });

  it('keeps the handle stable when the caller names it', () => {
    const first = upsertMember([], 'old@example.com', 'Wyat');
    const second = upsertMember(
      first.members,
      'new@example.com',
      'Wyat',
      first.member.handle
    );
    expect(second.member.handle).toBe(first.member.handle);
    expect(second.member.email).toBe('new@example.com');
    expect(second.member.emails).toContain('old@example.com');
    expect(second.members).toHaveLength(1);
  });

  it('matches a member by a prior address', () => {
    const first = upsertMember([], 'old@example.com', 'Wyat');
    const moved = upsertMember(
      first.members,
      'new@example.com',
      'Wyat',
      first.member.handle
    );
    const back = upsertMember(moved.members, 'old@example.com', 'Wyat');
    expect(back.members).toHaveLength(1);
  });

  it('never merges two people who share a display name', () => {
    const first = upsertMember([], 'alex.kim@example.com', 'Alex Kim');
    const second = upsertMember(first.members, 'akim@example.com', 'Alex Kim');
    expect(second.members).toHaveLength(2);
    expect(second.member.handle).not.toBe(first.member.handle);
  });

  it('ignores a known handle that is not in the roster', () => {
    const r = upsertMember([], 'w@example.com', 'Wyat', 'ghost');
    expect(r.members).toHaveLength(1);
    expect(r.member.handle).toBe('w');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/team.test.ts` Expected: FAIL — cannot resolve
`../src/team.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/team.ts`:

```ts
import { parse, stringify } from 'yaml';

// Pure roster shapes and transforms, no node:* imports — the server owns
// reading and writing `.dispatch/team.yml`.

export interface TeamMember {
  handle: string;
  email: string;
  displayName: string;
  /** Prior addresses, so a changed git email keeps its handle. */
  emails: string[];
}

const ILLEGAL = /[^a-z0-9._-]/g;

/** Derives a stable handle from an email's local part, suffixing on collision. */
export function handleFromEmail(email: string, taken: Set<string>): string {
  const local = email.slice(
    0,
    email.indexOf('@') === -1 ? undefined : email.indexOf('@')
  );
  const base =
    local
      .toLowerCase()
      .replace(ILLEGAL, '')
      .replace(/^[._-]+/, '') || 'member';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function parseTeam(yaml: string): TeamMember[] {
  const raw = yaml.trim() === '' ? null : parse(yaml);
  const members = raw?.members;
  if (!Array.isArray(members)) return [];
  return members.map((m) => ({
    handle: String(m.handle),
    email: String(m.email),
    displayName: String(m.displayName ?? m.handle),
    emails: Array.isArray(m.emails) ? m.emails.map(String) : [],
  }));
}

export function serializeTeam(members: TeamMember[]): string {
  return stringify({ members });
}

/**
 * Records the local developer in the roster. `knownHandle` is the caller's own
 * record of who it is, which is the only reliable way to survive an email
 * change — never guess identity from a display name, since two people share one.
 */
export function upsertMember(
  members: TeamMember[],
  email: string,
  displayName: string,
  knownHandle?: string
): { members: TeamMember[]; member: TeamMember; changed: boolean } {
  const found =
    (knownHandle === undefined
      ? undefined
      : members.find((m) => m.handle === knownHandle)) ??
    members.find((m) => m.email === email || m.emails.includes(email));
  if (found && found.email === email && found.displayName === displayName) {
    return { members, member: found, changed: false };
  }
  if (found) {
    const prior =
      found.email === email || found.emails.includes(found.email)
        ? found.emails
        : [...found.emails, found.email];
    const member: TeamMember = {
      ...found,
      email,
      displayName,
      emails: prior.filter((e) => e !== email),
    };
    return {
      members: members.map((m) => (m.handle === found.handle ? member : m)),
      member,
      changed: true,
    };
  }
  const member: TeamMember = {
    handle: handleFromEmail(email, new Set(members.map((m) => m.handle))),
    email,
    displayName,
    emails: [],
  };
  return { members: [...members, member], member, changed: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/test/team.test.ts` Expected: PASS, 11 tests.

- [ ] **Step 5: Export from both entry points**

Add to `packages/core/src/browser.ts`:

```ts
export {
  handleFromEmail,
  parseTeam,
  serializeTeam,
  upsertMember,
} from './team.js';
export type { TeamMember } from './team.js';
```

Add the same names to `packages/core/src/index.ts`.

- [ ] **Step 6: Verify and commit**

```bash
bun run format
bun ws core tsc
bun test packages/core/test/team.test.ts
git add packages/core/src/team.ts packages/core/test/team.test.ts \
  packages/core/src/browser.ts packages/core/src/index.ts
git commit -m "feat(core): add the team roster model

A board that names actors needs somewhere to record who they are. Add
pure parse/serialize/upsert helpers for .dispatch/team.yml, keyed on a
handle derived from the git email's local part. Matching on prior
addresses keeps the handle stable when someone changes their git email."
```

---

### Task 4: Resolve and self-register the local actor

**Files:**

- Create: `packages/server/src/actorContext.ts`
- Create: `packages/server/test/actorContext.test.ts`
- Modify: `packages/server/src/index.ts` (call it during daemon start)

**Interfaces:**

- Consumes: `TeamMember`, `parseTeam`, `serializeTeam`, `upsertMember` (Task 3);
  `formatActorRef` (Task 1).
- Produces: `class ActorContext` with
  `static resolve(rootDir: string, runGit: GitReader): ActorContext`; plus two
  module-private helpers, `readKnownHandle(rootDir): string | undefined` and
  `writeKnownHandle(rootDir, handle): void`, persisting this machine's own
  handle at `~/.dispatch/actor/<hash of rootDir>.json` — keyed exactly the way
  `packages/server/src/linear/state.ts:44` already keys its per-project state.
  This is user-level, not project-level: it must not live under `.dispatch/`,
  which is committed and shared. Add a test that a changed git email keeps the
  handle when this file is present, and yields a new member when it is absent;
  `readonly member: TeamMember`; `readonly humanRef: string` (e.g.
  `human:wyat`); `agentRef(executorId: string): string` (e.g.
  `agent:wyat/claude`). `type GitReader = (args: string[]) => string | null`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/actorContext.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ActorContext } from '../src/actorContext.js';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-actor-'));
  mkdirSync(join(root, '.dispatch'), { recursive: true });
  return root;
}

const gitOk = (args: string[]) =>
  args.includes('user.email') ? 'w@example.com' : 'Wyat Soule';

describe('ActorContext.resolve', () => {
  it('registers an unknown developer and writes the roster', () => {
    const root = fixture();
    const ctx = ActorContext.resolve(root, gitOk);
    expect(ctx.humanRef).toBe('human:w');
    expect(readFileSync(join(root, '.dispatch', 'team.yml'), 'utf8')).toContain(
      'w@example.com'
    );
  });

  it('does not rewrite the roster when nothing changed', () => {
    const root = fixture();
    ActorContext.resolve(root, gitOk);
    const before = readFileSync(join(root, '.dispatch', 'team.yml'), 'utf8');
    ActorContext.resolve(root, gitOk);
    expect(readFileSync(join(root, '.dispatch', 'team.yml'), 'utf8')).toBe(
      before
    );
  });

  it('builds an operator-scoped agent ref', () => {
    const ctx = ActorContext.resolve(fixture(), gitOk);
    expect(ctx.agentRef('claude')).toBe('agent:w/claude');
  });

  it('falls back to a local identity when git has no user configured', () => {
    const root = fixture();
    const ctx = ActorContext.resolve(root, () => null);
    expect(ctx.humanRef).toBe('human:local');
    expect(ctx.member.email).toBe('local@localhost');
  });

  it('keeps an existing member rather than adding a duplicate', () => {
    const root = fixture();
    writeFileSync(
      join(root, '.dispatch', 'team.yml'),
      'members:\n  - handle: w\n    email: w@example.com\n    displayName: Wyat Soule\n    emails: []\n'
    );
    const ctx = ActorContext.resolve(root, gitOk);
    expect(ctx.member.handle).toBe('w');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/actorContext.test.ts` Expected: FAIL —
cannot resolve `../src/actorContext.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/server/src/actorContext.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DISPATCH_DIR,
  parseTeam,
  serializeTeam,
  upsertMember,
} from '@dispatch/core';
import type { TeamMember } from '@dispatch/core';

/** Reads one git config value; returns null when git or the key is unavailable. */
export type GitReader = (args: string[]) => string | null;

const FALLBACK_EMAIL = 'local@localhost';
const FALLBACK_NAME = 'Local';

/**
 * The identity this daemon acts as. Derived from git config and recorded in
 * `.dispatch/team.yml` on first sight, so joining a team needs no invite step.
 */
export class ActorContext {
  private constructor(
    readonly member: TeamMember,
    readonly humanRef: string
  ) {}

  static resolve(rootDir: string, runGit: GitReader): ActorContext {
    const email = runGit(['config', 'user.email'])?.trim() || FALLBACK_EMAIL;
    const name = runGit(['config', 'user.name'])?.trim() || FALLBACK_NAME;
    const dir = join(rootDir, DISPATCH_DIR);
    const file = join(dir, 'team.yml');
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    // The handle we registered under last time. It is the only thing that
    // survives a changed git email — the roster cannot infer identity itself.
    const result = upsertMember(
      parseTeam(existing),
      email,
      name,
      readKnownHandle(rootDir)
    );
    if (result.changed) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, serializeTeam(result.members));
    }
    writeKnownHandle(rootDir, result.member.handle);
    return new ActorContext(result.member, `human:${result.member.handle}`);
  }

  /** The ref for an agent this developer operates, e.g. `agent:wyat/claude`. */
  agentRef(executorId: string): string {
    return `agent:${this.member.handle}/${executorId}`;
  }
}
```

Note the fallback: with no git identity the email is `local@localhost`, whose
local part yields the handle `local`, so `humanRef` is `human:local`.

**A conflicted roster must never be overwritten.** `parseTeam` throws
`TeamParseError` when `.dispatch/team.yml` is malformed — a realistic state for
a committed, shared, mergeable file. `resolve()` must catch it and **stand
down**: serve an unregistered identity derived from the git email, and write
nothing. Returning an empty roster and re-registering would rewrite `team.yml`
with only the local member and destroy every teammate's entry.

```ts
let existingMembers: TeamMember[] = [];
let rosterReadable = true;
try {
  existingMembers = parseTeam(existing);
} catch {
  rosterReadable = false;
}
```

Guard the write with `if (rosterReadable && result.changed)`, and expose
`readonly rosterReadable: boolean` on `ActorContext` so the daemon can surface
the degraded state. Add a test: a `team.yml` holding merge-conflict markers
leaves the file byte-for-byte unchanged, and `resolve()` still returns a usable
`humanRef`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/server/test/actorContext.test.ts` Expected: PASS, 5
tests.

- [ ] **Step 5: Wire it into daemon start**

In `packages/server/src/index.ts`, resolve the context once during startup (next
to where the store and config are set up) and hold it on the server context so
later tasks can read it. Use the repo's existing git-invocation helper from
`packages/server/src/git/commands.ts` as the `GitReader`; if none exposes a
plain "read one config value" call, add a thin local wrapper around
`Bun.spawnSync(['git', ...args], { cwd: rootDir })` returning `stdout` on exit
code 0 and `null` otherwise.

- [ ] **Step 6: Verify and commit**

```bash
bun run format
bun ws server tsc
bun test packages/server/test/actorContext.test.ts
git add packages/server/src/actorContext.ts \
  packages/server/test/actorContext.test.ts packages/server/src/index.ts
git commit -m "feat(server): resolve and self-register the local actor

Derive the developer's identity from git config on daemon start and
append it to .dispatch/team.yml when it is not already there, so a
teammate joins the roster through the same commit that carries their
first task edit rather than through an invite flow."
```

---

### Task 5: Attribute Activity lines

**Files:**

- Modify: `packages/core/src/taskfile.ts:223` (`appendActivity`)
- Modify: `packages/core/src/store.ts` (`UpdatePatch.appendActivity` call site)
- Test: `packages/core/test/activity.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks at the core layer — the actor arrives as
  an already-serialized string supplied by the caller.
- Produces: `appendActivity(body: string, line: string, actor?: string): string`
  — appends `— <actor>` when supplied. `UpdatePatch` gains
  `activityActor?: string`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/activity.test.ts`:

```ts
describe('appendActivity attribution', () => {
  it('appends the actor when one is given', () => {
    const body = appendActivity(
      '## Activity\n',
      'moved to in-review',
      'human:wyat'
    );
    expect(body).toContain('- moved to in-review — human:wyat');
  });

  it('omits the suffix when no actor is given', () => {
    const body = appendActivity('## Activity\n', 'moved to in-review');
    expect(body.trimEnd().endsWith('- moved to in-review')).toBe(true);
  });

  it('escapes the line before the actor is appended', () => {
    const body = appendActivity(
      '## Activity\n',
      '## not a heading',
      'human:wyat'
    );
    expect(body).toContain('— human:wyat');
    expect(body).not.toMatch(/^## not a heading$/m);
  });
});
```

Add `appendActivity` to the file's existing import from `../src/taskfile.js` if
it is not already there.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/activity.test.ts` Expected: FAIL — the actor
suffix is absent.

- [ ] **Step 3: Implement**

In `packages/core/src/taskfile.ts`, replace `appendActivity`:

```ts
export function appendActivity(
  body: string,
  line: string,
  actor?: string
): string {
  // `line` is caller-supplied text (e.g. an agent's task_comment) appended
  // straight onto the body, so it's escaped the same as setSection's content.
  // `actor` is a validated ActorRef, so it needs no escaping.
  const suffix = actor === undefined ? '' : ` — ${actor}`;
  const entry = `- ${escapeHeadingLines(line)}${suffix}`;
  if (!/^## Activity\s*$/m.test(body)) {
    return `${body.trimEnd()}\n\n## Activity\n\n${entry}\n`;
  }
  return `${body.trimEnd()}\n${entry}\n`;
}
```

- [ ] **Step 4: Thread it through the store**

In `packages/core/src/store.ts`, add to `UpdatePatch` beside `appendActivity`:

```ts
  // The serialized ActorRef credited for `appendActivity`. Omitted leaves the
  // line unattributed, which is what pre-team task files already look like.
  activityActor?: string;
```

In `update()`, destructure `activityActor` alongside `appendActivity` so it is
never spread into `meta`, and pass it through:

```ts
if (activityLine) body = appendActivity(body, activityLine, activityActor);
```

- [ ] **Step 5: Run tests to verify they pass**

Run:
`bun test packages/core/test/activity.test.ts packages/core/test/store.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify and commit**

```bash
bun run format
bun ws core tsc
git add packages/core/src/taskfile.ts packages/core/src/store.ts \
  packages/core/test/activity.test.ts
git commit -m "feat(core): credit an actor on Activity lines

The Activity log is the durable, git-visible record of who did what, but
every line was anonymous. Append an optional actor suffix and thread it
through UpdatePatch. Omitting it leaves the line exactly as before, so
existing callers and existing task files are unaffected."
```

---

### Task 6: Attribute findings, ledger entries, and review comments

**Files:**

- Modify: `packages/core/src/findings.ts` (add `raisedBy`)
- Modify: `packages/core/src/ledger.ts` (add `authoredBy`)
- Modify: `packages/server/src/findings.ts`, `packages/server/src/ledger.ts`
  (read with a default)
- Modify: `packages/server/src/reviewComments.ts:150` and `:167`
- Test: `packages/core/test/findings.test.ts`,
  `packages/server/test/review-comments.test.ts`

**Interfaces:**

- Consumes: `ActorContext.humanRef` (Task 4) at the server call sites.
- Produces: `Finding.raisedBy: string`, `LedgerEntry.authoredBy: string`,
  `ReviewComment.author` no longer defaults to the literal `'You'`.

- [ ] **Step 1: Write the failing test**

Add to the server's findings store test file (find it under
`packages/server/test/` — read the existing tests first and match their fixture
style). These test real behaviour, not the type:

```ts
it('round-trips the actor that raised a finding', () => {
  const root = fixture();
  const store = new FindingsStore(root);
  const written = store.add({
    taskId: 't-abc123',
    runId: null,
    severity: 'important',
    verdict: 'open',
    title: 'x',
    detail: 'y',
    file: null,
    line: null,
    round: 0,
    raisedBy: 'agent:wyat/claude',
  });
  expect(new FindingsStore(root).list()).toContainEqual(
    expect.objectContaining({ id: written.id, raisedBy: 'agent:wyat/claude' })
  );
});

it('defaults raisedBy on a record written before attribution existed', () => {
  const root = fixture();
  mkdirSync(join(root, '.dispatch'), { recursive: true });
  // A legacy line: every field except raisedBy.
  writeFileSync(
    join(root, '.dispatch', 'findings.jsonl'),
    `${JSON.stringify({
      id: 'f-legacy',
      taskId: 't-abc123',
      runId: null,
      severity: 'minor',
      verdict: 'open',
      title: 'old',
      detail: '',
      file: null,
      line: null,
      ruling: null,
      round: 0,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    })}\n`
  );
  expect(new FindingsStore(root).list()[0]?.raisedBy).toBe('');
});
```

Adjust `FindingsStore`, `add`, and `list` to the real member names in
`packages/server/src/findings.ts`. Add the equivalent pair for `authoredBy` in
the ledger store's test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/` (the findings and ledger test files)
Expected: FAIL — `raisedBy` is not a property of `Finding`, and the legacy
record loads without the defaulted field.

- [ ] **Step 3: Add the fields**

In `packages/core/src/findings.ts`, add to `Finding`:

```ts
/** Serialized ActorRef of whoever raised it; empty for pre-team records. */
raisedBy: string;
```

In `packages/core/src/ledger.ts`, add to `LedgerEntry`:

```ts
/** Serialized ActorRef of whoever wrote it; empty for pre-team records. */
authoredBy: string;
```

- [ ] **Step 4: Default the field when reading existing JSONL**

In `packages/server/src/findings.ts` and `packages/server/src/ledger.ts`, the
readers parse each line with `JSON.parse`. Normalize after parsing so records
written before this change stay loadable:

```ts
const record = JSON.parse(line) as Finding;
return { ...record, raisedBy: record.raisedBy ?? '' };
```

Apply the equivalent for `authoredBy` in the ledger store. Both files are
append-only (`appendFileSync`) and must stay that way — that is what makes them
union-mergeable across teammates.

- [ ] **Step 5: Set the author on review comments**

In `packages/server/src/reviewComments.ts`, replace the two `'You'` literals
(lines 150 and 167) with a constructor-injected default actor. Add a
`defaultAuthor: string` to the store's constructor, supplied from
`ActorContext.humanRef` at the wiring site, and use it in place of the literal.
Keep `input.author ?? this.defaultAuthor` so an explicit author still wins.

Update `packages/server/test/review-comments.test.ts`: the fixtures asserting
`author: 'You'` should construct the store with an explicit default and assert
that value instead.

- [ ] **Step 6: Fix every construction site**

Run `bun run tsc` and add `raisedBy` / `authoredBy` at each place a `Finding` or
`LedgerEntry` is constructed. In server code use the acting actor —
`ActorContext.humanRef` for a human action, `agentRef(executorId)` for one
raised inside a run. In tests use `''` unless the test is about attribution.

- [ ] **Step 7: Verify and commit**

```bash
bun run format
bun run tsc
bun test packages/core/test/findings.test.ts packages/core/test/ledger.test.ts \
  packages/server/test/review-comments.test.ts
git add -A
git commit -m "feat(core,server): attribute findings, ledger entries and comments

Every review comment was authored by the literal 'You', and findings and
ledger entries recorded no actor at all, so none of the three could say
who acted once more than one person shares a board. Record the actor on
each. Readers default the new field, so JSONL written before this change
still loads."
```

---

### Task 7: Task-file merge driver

**Files:**

- Create: `packages/core/src/mergeTask.ts`
- Create: `packages/core/test/mergeTask.test.ts`
- Create: `packages/cli/src/commands/mergeTask.ts` (follow the existing command
  layout in `packages/cli/src`)
- Modify: the CLI's command registration, `dispatch init`, and `dispatch doctor`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:
  `mergeTaskFile(base: string, ours: string, theirs: string): { ok: boolean; merged: string }`.
  `ok: false` means a genuine conflict and the returned text carries standard
  `<<<<<<<`/`=======`/`>>>>>>>` markers.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/mergeTask.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';

import { mergeTaskFile } from '../src/mergeTask.js';

const doc = (fields: Record<string, string>, activity: string[]) =>
  [
    '---',
    ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`),
    '---',
    '',
    '## Activity',
    '',
    ...activity.map((a) => `- ${a}`),
    '',
  ].join('\n');

const base = doc({ id: 't-abc123', status: 'todo', priority: 'none' }, [
  'created',
]);

describe('mergeTaskFile', () => {
  it('unions Activity lines added on both sides', () => {
    const ours = doc({ id: 't-abc123', status: 'todo', priority: 'none' }, [
      'created',
      'alice commented',
    ]);
    const theirs = doc({ id: 't-abc123', status: 'todo', priority: 'none' }, [
      'created',
      'bob commented',
    ]);
    const result = mergeTaskFile(base, ours, theirs);
    expect(result.ok).toBe(true);
    expect(result.merged).toContain('- alice commented');
    expect(result.merged).toContain('- bob commented');
  });

  it('takes both changes when different fields moved', () => {
    const ours = doc(
      { id: 't-abc123', status: 'in-progress', priority: 'none' },
      ['created']
    );
    const theirs = doc({ id: 't-abc123', status: 'todo', priority: 'high' }, [
      'created',
    ]);
    const result = mergeTaskFile(base, ours, theirs);
    expect(result.ok).toBe(true);
    expect(result.merged).toContain('status: in-progress');
    expect(result.merged).toContain('priority: high');
  });

  it('conflicts when both sides set the same field differently', () => {
    const ours = doc(
      { id: 't-abc123', status: 'in-progress', priority: 'none' },
      ['created']
    );
    const theirs = doc({ id: 't-abc123', status: 'done', priority: 'none' }, [
      'created',
    ]);
    const result = mergeTaskFile(base, ours, theirs);
    expect(result.ok).toBe(false);
    expect(result.merged).toContain('<<<<<<<');
  });

  it('does not duplicate an identical line added on both sides', () => {
    const same = doc({ id: 't-abc123', status: 'todo', priority: 'none' }, [
      'created',
      'same line',
    ]);
    const result = mergeTaskFile(base, same, same);
    expect(result.ok).toBe(true);
    expect(result.merged.match(/- same line/g)).toHaveLength(1);
  });

  it('keeps the newer updated timestamp without conflicting', () => {
    const b = doc({ id: 't-abc123', updated: '2026-08-01T00:00:00.000Z' }, []);
    const ours = doc(
      { id: 't-abc123', updated: '2026-08-02T00:00:00.000Z' },
      []
    );
    const theirs = doc(
      { id: 't-abc123', updated: '2026-08-03T00:00:00.000Z' },
      []
    );
    const result = mergeTaskFile(b, ours, theirs);
    expect(result.ok).toBe(true);
    expect(result.merged).toContain('updated: 2026-08-03T00:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/mergeTask.test.ts` Expected: FAIL — cannot
resolve `../src/mergeTask.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/mergeTask.ts`. Operate on raw text rather than
`parseTaskFile`, because a file reaching the driver may hold values the strict
parser would reject.

```ts
import { parse, stringify } from 'yaml';

// A three-way merge that understands a task file: Activity is append-only so
// it unions, and frontmatter merges per field rather than per line.

interface Split {
  fields: Record<string, unknown>;
  sections: Map<string, string[]>;
  order: string[];
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

function split(text: string): Split {
  const match = FRONTMATTER.exec(text);
  const fields = match
    ? ((parse(match[1] ?? '') ?? {}) as Record<string, unknown>)
    : {};
  const body = match ? text.slice(match[0].length) : text;
  const sections = new Map<string, string[]>();
  const order: string[] = [];
  let current = '';
  sections.set(current, []);
  order.push(current);
  for (const line of body.split('\n')) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      current = heading[1] ?? '';
      if (!sections.has(current)) {
        sections.set(current, []);
        order.push(current);
      }
      continue;
    }
    sections.get(current)?.push(line);
  }
  return { fields, sections, order };
}

// Standard three-way pick: unchanged sides defer, equal sides agree.
function pick<T>(b: T, o: T, t: T, eq: (x: T, y: T) => boolean): T | null {
  if (eq(o, t)) return o;
  if (eq(b, o)) return t;
  if (eq(b, t)) return o;
  return null;
}

const same = (x: unknown, y: unknown) =>
  JSON.stringify(x) === JSON.stringify(y);

function conflictBlock(ours: string, theirs: string): string {
  return `<<<<<<< ours\n${ours}\n=======\n${theirs}\n>>>>>>> theirs`;
}

export function mergeTaskFile(
  base: string,
  ours: string,
  theirs: string
): { ok: boolean; merged: string } {
  const b = split(base);
  const o = split(ours);
  const t = split(theirs);
  let ok = true;

  const fields: Record<string, unknown> = {};
  const keys = [
    ...new Set([
      ...Object.keys(o.fields),
      ...Object.keys(t.fields),
      ...Object.keys(b.fields),
    ]),
  ];
  for (const key of keys) {
    // `updated` is a monotonic clock, not a value to reconcile — take the max.
    if (key === 'updated') {
      const values = [o.fields[key], t.fields[key]].filter(
        (v): v is string => typeof v === 'string'
      );
      fields[key] = values.sort().at(-1) ?? b.fields[key];
      continue;
    }
    const chosen = pick(b.fields[key], o.fields[key], t.fields[key], same);
    if (chosen === null) {
      ok = false;
      fields[key] =
        `CONFLICT ours=${JSON.stringify(o.fields[key])} theirs=${JSON.stringify(t.fields[key])}`;
      continue;
    }
    if (chosen !== undefined) fields[key] = chosen;
  }

  const order = [...new Set([...o.order, ...t.order])];
  const parts: string[] = [];
  for (const heading of order) {
    const bl = b.sections.get(heading) ?? [];
    const ol = o.sections.get(heading) ?? [];
    const tl = t.sections.get(heading) ?? [];
    let lines: string[];
    if (heading === 'Activity') {
      // Append-only by construction, so union preserving our order, then
      // whatever the other side added that we have not seen.
      const seen = new Set(ol);
      lines = [...ol, ...tl.filter((l) => l.trim() !== '' && !seen.has(l))];
    } else {
      const chosen = pick(bl, ol, tl, same);
      if (chosen === null) {
        ok = false;
        lines = [conflictBlock(ol.join('\n'), tl.join('\n'))];
      } else {
        lines = chosen;
      }
    }
    if (heading === '') {
      parts.push(lines.join('\n'));
      continue;
    }
    parts.push(`## ${heading}`, lines.join('\n'));
  }

  const merged = `---\n${stringify(fields).trimEnd()}\n---\n${parts.join('\n')}`;
  return { ok, merged: merged.endsWith('\n') ? merged : `${merged}\n` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/test/mergeTask.test.ts` Expected: PASS, 5 tests.

- [ ] **Step 5: Add the CLI entry point**

Add a `merge-task` command taking positional `%O %A %B` (base, ours, theirs). It
reads the three files, calls `mergeTaskFile`, writes the result over the `%A`
path, and exits `0` on `ok` or `1` otherwise — the contract a git merge driver
must satisfy.

Export `mergeTaskFile` from `packages/core/src/index.ts`.

- [ ] **Step 6: Register the driver from init and doctor**

`dispatch init` writes (creating or appending, never clobbering an existing
line):

```text
# .gitattributes
.dispatch/tasks/*.md merge=dispatch-task
```

and sets the local git config:

```bash
git config merge.dispatch-task.name "Dispatch task file merge"
git config merge.dispatch-task.driver "dispatch merge-task %O %A %B"
```

`dispatch doctor` reports when either the `.gitattributes` line or the git
config entry is missing, since a fresh clone gets the committed `.gitattributes`
but not the local config. Absent the driver, git falls back to ordinary
conflicts — degraded, not broken.

- [ ] **Step 7: Verify and commit**

```bash
bun run format
bun run tsc
bun test packages/core/test/mergeTask.test.ts
git add -A
git commit -m "feat(core,cli): merge task files field-by-field

Two people appending to a task's Activity log conflict on every overlap,
because git merges the file as opaque lines. Add a merge driver that
unions Activity — append-only by construction — and merges frontmatter
per field, conflicting only when both sides set one field differently.
Register it from init and report it missing from doctor; without it git
falls back to ordinary conflicts."
```

---

### Task 8: Partition the inbox per actor

**Files:**

- Modify: `packages/server/src/inbox.ts` (path, constructor, migration)
- Modify: `packages/server/src/inboxClusterer.ts` (read across all actors)
- Modify: `packages/server/src/index.ts` (migration call site)
- Test: `packages/server/test/` — the existing inbox tests

**Interfaces:**

- Consumes: `ActorContext.member.handle` (Task 4).
- Produces: `InboxStore` takes an actor handle and reads/writes
  `.dispatch/inbox/<handle>.md`; `listAll()` returns items across every actor
  file, each tagged with its handle.

- [ ] **Step 1: Write the failing test**

Add to the existing inbox test file:

```ts
it('writes to a per-actor file', () => {
  const root = fixture();
  const store = new InboxStore(root, 'wyat');
  store.add('a thought');
  expect(existsSync(join(root, '.dispatch', 'inbox', 'wyat.md'))).toBe(true);
});

it('reads items from every actor for clustering', () => {
  const root = fixture();
  new InboxStore(root, 'wyat').add('mine');
  new InboxStore(root, 'alice').add('theirs');
  const all = new InboxStore(root, 'wyat').listAll();
  expect(all.map((i) => i.actor).sort()).toEqual(['alice', 'wyat']);
});

it('migrates a legacy single-file inbox to the local actor', () => {
  const root = fixture();
  mkdirSync(join(root, '.dispatch'), { recursive: true });
  writeFileSync(join(root, '.dispatch', 'inbox.md'), '- legacy item\n');
  const store = new InboxStore(root, 'wyat');
  store.migrateLegacy();
  expect(store.list().map((i) => i.text)).toContain('legacy item');
  expect(existsSync(join(root, '.dispatch', 'inbox.md'))).toBe(false);
});
```

Match the exact `InboxStore` API and item shape already in `inbox.ts` — the
assertions above use `add`/`list`/`text` as placeholders for whatever the file
actually names them. Read `packages/server/src/inbox.ts` first and adjust.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/` (the inbox test file) Expected: FAIL — the
store still writes `.dispatch/inbox.md`.

- [ ] **Step 3: Implement**

Change the store's file path from `join(rootDir, DISPATCH_DIR, 'inbox.md')` to
`join(rootDir, DISPATCH_DIR, 'inbox',`${handle}.md`)`, creating the directory on
write. Add `listAll()` scanning `.dispatch/inbox/*.md` and tagging each item
with the handle taken from its filename. Add `migrateLegacy()` moving an
existing `.dispatch/inbox.md` into the local actor's file and deleting the
original, mirroring the `notes.json` → `inbox.md` migration already at
`packages/server/src/index.ts:303`.

Point `inboxClusterer.ts` at `listAll()` so clustering still sees the whole
team's captures.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/` Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
bun run format
bun run tsc
bun test packages/server/test/
git add -A
git commit -m "feat(server): give each actor their own inbox file

The inbox was one shared file rewritten whole on every change, which is
the worst possible shape for concurrent writers. Brain-dump capture is
personal, so partition it per actor and remove the conflict class
outright rather than merging around it. Clustering reads across every
actor's file, and a legacy inbox.md migrates into the local actor's."
```

---

## Self-Review

**Spec coverage for §8 steps 1–2:**

| Spec section                    | Task |
| ------------------------------- | ---- |
| §4.1 Actor model                | 1, 2 |
| §4.2 Roster (`team.yml`)        | 3, 4 |
| §4.3 Attribution                | 5, 6 |
| §4.6 Merge driver + append-only | 7    |
| §4.7 Per-actor inbox            | 8    |

§4.4 (timeline extraction), §4.5 (board syncer), §4.8–4.10
(presence/claims/messaging), §4.11 (audit export) and §4.12 (surfaces) are steps
3–6 and belong to later plans.

**Type consistency:** `ActorRef`/`parseActorRef`/`formatActorRef` (Task 1) are
used under those exact names in Tasks 2 and 4. `TeamMember`/`upsertMember`
(Task 3) match their use in Task 4. `ActorContext.humanRef`/`agentRef` (Task 4)
match Tasks 5 and 6. `mergeTaskFile` (Task 7) is referenced only by its own CLI
command.

**Known softness, flagged rather than hidden:** Tasks 6 and 8 depend on the
current shapes of `reviewComments.ts` and `inbox.ts`, whose exact member names
this plan does not reproduce in full. Both tasks say to read the file first and
match its real API. Every other task carries complete code.

## Out of scope for this plan

Board syncing, presence, claims, cross-machine `run_list`/`agent_message`, audit
export, and the desktop Team page. Nothing here pushes to a remote or opens a
network connection; this plan makes the board _able_ to name actors and _safe_
to write concurrently, which every later plan assumes.
