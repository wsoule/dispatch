# Changelog

Notes for the next release. The release commit carries the summary; this file
holds what a user upgrading needs to know.

## Unreleased

### Added

- **The Overseer and run chats show the agent as it writes.** A running turn's
  text streams into the chat, the Overseer keeps what it says between tool calls
  as narration, and a run's tool chips end done or failed. The Overseer's
  approval card takes a reason when you deny, as a run's does. To stop
  streaming, set `overseer.stream` (`live`, `narration` or `off`) or
  `runs.stream` (`live` or `off`) in `.dispatch/config.yml`.
- **Update the desktop app and the `dispatch` CLI together with the daemon.**
  Claude runs now log how each tool call ended as an entry of its own. A desktop
  or CLI older than this release, attached to a newer daemon, shows each of
  those as an extra generic "tool" chip, or an extra `[tool ✓] unknown` line in
  `dispatch run --watch`, `run show` and `run watch`, for every Claude run the
  newer daemon logged.

### Changed

- **Epics are now milestones, everywhere.** The hierarchy is initiative ›
  project › milestone › task, and nothing says "epic" any more: the CLI's
  `dispatch epic` is `dispatch milestone`, the daemon serves `/api/milestones/*`
  instead of `/api/epics/*`, milestone branches are `milestone/<id>`, the
  implicit channel is `channel:milestone/<id>`, and MCP tools take `milestone`
  where they took `epic`. There are no aliases, so update the desktop app, the
  CLI and `@dispatch-foo/mcp` together with the daemon. The daemon moves its own
  state on first boot: `orchestrator.epicConcurrency` becomes
  `milestoneConcurrency` in `.dispatch/config.yml`, the run ledgers are renamed,
  and the task and memory databases are migrated (older builds cannot open them
  afterwards). Open `epic/<id>` branches are not renamed; land or re-dispatch
  them first. In the task list, group by **Parent** for what was "Epic", and the
  `e` shortcut is gone (`m` sets the milestone).

- **`dispatch team invite` now makes a team invite link.** It prints one
  `dispatch-team:` link that a teammate pastes into `dispatch team join` (or
  Settings → Team) to join your signed team. The old behaviour, a sign-in token
  for a teammate on a shared daemon, is `dispatch team host invite`; running
  `dispatch team invite` with `--tier`, `--expires` or `--name` still issues
  one, with a note.
- **Team setup is two actions each.** `dispatch team start` founds the team on
  the hosted relay (or `--git`), turning board sync on if it is off; then
  `dispatch team invite <email or handle>`. Teammates run `dispatch team join`.
- **Older team commands moved.** `found`, `trust`, `keys`, `admit`, `dismiss`,
  `close-legacy`, `transport` and the rest are under `dispatch team advanced`,
  and `tokens` and `revoke` under `dispatch team host`. The old names still
  work.

### Removed

- **`dispatch tui` is gone**, with the terminal UI it opened. The desktop app
  covers the Overseer, Tasks and Runs, and `dispatch run`, `dispatch approvals`
  and `dispatch approve` cover runs from a terminal.
