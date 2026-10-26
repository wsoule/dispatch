# Changelog

Notes for the next release. The release commit carries the summary; this file
holds what a user upgrading needs to know.

## Unreleased

### Added

- **The Overseer and run chats show the agent as it writes.** A running turn's
  text streams into the chat, the Overseer keeps what it says between tool calls
  as narration, and tool chips in both chats end done or failed. The Overseer's
  approval card takes a reason when you deny, as a run's does. To stop
  streaming, use Settings → Agents → Streaming, or set `overseer.stream`
  (`live`, `narration` or `off`) or `runs.stream` (`live` or `off`) in
  `.dispatch/config.yml`.
- **Update the desktop app and the `dispatch` CLI together with the daemon.**
  Claude runs now log how each tool call ended as an entry of its own. A desktop
  or CLI older than this release, attached to a newer daemon, shows each of
  those as an extra generic "tool" chip, or an extra `[tool ✓] unknown` line in
  `dispatch run --watch`, `run show` and `run watch`, for every Claude run the
  newer daemon logged. An older desktop also shows an empty message card where
  the newer daemon withholds a run's message from you.

### Changed

- **Saving a setting leaves the rest of `.dispatch/config.yml` as you wrote
  it.** A long line, such as a verify or preview command, is no longer wrapped
  onto a second line, a file with CRLF line ends keeps them, and a block whose
  keys are all commented out takes a save instead of refusing it with "Expected
  YAML collection". An inline list or map still comes back with spaces inside
  its brackets: `[a, b]` as `[ a, b ]`.
- **A run's messages stay between the people in them.** A message delivered to a
  run, a channel digest and a run's own message to a person now show in the
  run's chat only for the people the message is between and for teammates who
  can decide. Anyone else sees nothing in its place, live and in
  `GET /api/runs/:id`, and so does the shared agent token: `dispatch run show`,
  `run watch`, `dispatch run --watch` and `dispatch share` no longer print those
  messages. Whoever may read one still finds it in the desktop's Threads view.
  The run's `msg_send` and `msg_reply` calls in its chat now show only whom the
  message was for, not what it said.
- **A Codex run's command output is cut at 2,000 characters** in its chat, with
  "… (truncated)" at the cut, as an Overseer tool row already was.
- **An Overseer action you had not confirmed ends with a restart.** It used to
  stay on its confirm card after Dispatch restarted, where neither button could
  work. The conversation now says "Denied: … — Dispatch restarted before anyone
  decided", and the Overseer hears on its next turn that it did not happen; ask
  it again to queue the action anew.
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
