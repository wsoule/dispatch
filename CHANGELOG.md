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
- **The Overseer shows how full its context is.** Its status line, beside what
  the conversation has cost, reads "62% context": how close the agent is to its
  context limit, the point where its next turn starts afresh from a recap of the
  latest lines. A daemon older than the desktop shows no meter.
- **Update the desktop app and the `dispatch` CLI together with the daemon.**
  Claude runs now log how each tool call ended as an entry of its own. A desktop
  or CLI older than this release, attached to a newer daemon, shows each of
  those as an extra generic "tool" chip, or an extra `[tool ✓] unknown` line in
  `dispatch run --watch`, `run show` and `run watch`, for every Claude run the
  newer daemon logged. An older desktop also shows an empty message card where
  the newer daemon withholds a run's message from you.

### Changed

- **The desktop app has one look.** Every view uses the same design system:
  Settings opens as a page in the main column (⌘, and Escape still work); the
  board, chat, runs, review, docs and threads share one set of controls; and the
  sidebar flips the theme between light and dark, while Settings → General also
  offers follow-the-system. ⌘P opens quick open over the project's files. The
  desktop app keeps the theme choice for every project; in a browser opened on a
  daemon (`dispatch ui`), each daemon port keeps its own, so another port starts
  from the system theme until you choose again.
- **A CLI agent's output reads as one text in its run chat.** Gemini, Qwen,
  Cursor, opencode, Crush, Goose, Aider and any agent you set up with
  `executors.<name>.command` print their answer in pieces, and the chat used to
  render each piece on its own, so a code block or a list cut between two of
  them came out broken. Runs started after you upgrade the daemon and the
  desktop show the pieces joined; older runs show as before.
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
- **A run's chat no longer shows what it wrote into docs and memory.** Its
  `doc_save`, `memory_save` and `memory_forget` calls show which doc or memory
  they touched and how (scope, kind, the kind of each edit), not the title, body
  or reason: a personal doc or memory, or a proposal, is for fewer people than
  can read the run. A Claude run's writes and edits to the memory files Dispatch
  hands it show only which file. Open the doc or the memory to read what it
  says.
- **A Codex run's command output is cut at 2,000 characters** in its chat, with
  "… (truncated)" at the cut, as an Overseer tool row already was.
- **An Overseer action you had not confirmed ends with a restart.** It used to
  stay on its confirm card after Dispatch restarted, where neither button could
  work. The conversation now says "Denied: … — Dispatch restarted before anyone
  decided", and the Overseer hears on its next turn that it did not happen; ask
  it again to queue the action anew.
- **Sending from Tasks leaves the Overseer page's unsent message alone.** The
  "say something" box in Tasks used to empty what you had typed on the Overseer
  page, take the files waiting there with its own message, and, when the send
  failed, put its text into the Overseer page's box. It now keeps its own text,
  files and error, and the Overseer page keeps its own; switching projects
  empties both.
- **An open Overseer conversation shows the agent is off as soon as it is
  revoked, and on again as soon as it is approved.** "The agent is off." used to
  appear only after a message to the revoked agent failed, and stayed, with the
  composer locked, after you approved it again in Settings → Connected agents,
  until the app reloaded. Every window with a conversation open now follows the
  agent's state as it changes. With none open, a window learns it from your next
  message, which it always lets you send.
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
