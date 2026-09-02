# Archive

Dated plans, specs, and research from earlier phases of Dispatch. **These are
historical records, not current documentation.** They describe what was intended
and decided at the time they were written; the code has moved since, and some of
them describe designs that were superseded or never built.

Read them to understand _why_ a decision was made. Do not read them to learn how
the system behaves today — see `docs/ARCHITECTURE.md` for that.

Known superseded:

- `specs/2026-08-02-team-collaboration-design.md` — specced team collaboration
  over git refs (mode A) with a hosted CRDT relay as an optional second mode.
  Team collaboration is moving to a server (`docs/TEAM-SERVER.md`); the
  git-native design is no longer the direction.
- `design/lovable-direction.md` and `design/lovable-workstreams.md` — the
  direction docs behind the agreed storage spine and hosted tier (epics
  `e-99e113`, `e-e2d9c0` and others still cite their old `docs/design/` paths).
  Their substance is absorbed into `docs/TEAM-SERVER.md`; read them for the
  fuller original reasoning.

Nothing here is maintained. Do not update these files — write a new document
instead.
