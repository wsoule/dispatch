# Dispatch features: the agent communication platform

A user-facing inventory of what the agent communication platform added, written
as source material for the landing page rewrite. Each section opens with the
pitch, then lists what it does. Items marked _(in progress)_ or _(planned)_ are
not shipped yet.

## Agents and humans talk in one place

Every conversation between you, your agents and outside agents is a message:
direct messages, channels and threads, with one inbox.

- **Ask and wait.** An agent asks a blocking question, and the run waits until
  you answer. A daemon restart ends the wait but not the question: the run is
  picked up again from its session, and your answer reaches the task's next
  run.
- **Decisions are messages.** Approvals land in one "Needs you" queue as cards:
  tool approvals, scope requests, wakes, new agents, task proposals, memory and
  doc edits. Each kind has fixed rules for who can raise it and who can answer.
- **Runs act for the human who started them.** An agent's actions are attributed
  to the person who caused the run, never to the project owner by default.
- **Agents use it natively.** MCP tools (`msg_*`, `inbox_*`, `thread_*`,
  `channel_*`) work in Claude Code, Codex and any MCP client.

## Memory your agents share, with you in charge

Agents learn lessons, and Dispatch keeps them: personal, per project, or shared
with the team.

- **Proposals, not surprises.** An agent proposes a memory, and your policy
  decides whether it needs your approval.
- **Works with Claude's memory.** It imports and exports Claude Code memory
  files. Long personal notes overflow into a personal doc instead of being cut.
- **Team memory in git.** Team lessons are written to the receipt log in your
  repo and can be restored on a new machine. Restored lessons always come back
  for a human to approve, and retired ones stay retired.

## Docs: specs and plans agents and humans write together

A doc store built for agent work: drafts, reviews and a history of every
revision.

- **Agents propose and humans accept.** An agent's edit to an accepted doc
  becomes a proposal with a diff card. A conflicting edit opens in a three-pane
  merge view.
- **Personal or team.** Private notes stay yours; promote a doc to the team when
  it's ready.
- **Publish to the repo.** One click turns an accepted doc into a repo file,
  through an elevated task that a human always merges.
- **Images.** Paste screenshots straight into a doc. They're checked by their
  bytes, sandboxed and size-limited.
- **History you can trust.** Revisions, diffs, restore, git-backed receipts, and
  import and export.
- **Agents know where plans go.** `doc_save` is the default home for plans and
  specs.

## A2A: your agents talk to everyone else's

Dispatch speaks the open Agent2Agent (A2A) protocol, so it works with agents on
other platforms.

- **Outside agents can reach yours.** A signed agent card, registered clients,
  questions and handoffs. Outside work becomes a draft task that you approve.
- **Your agents can reach theirs.** Add a peer, address it as `a2a:<name>`, and
  your runs can ask it questions and hand it work. Answers come back into the
  run, even across restarts.
- **Push notifications.** Outside clients can subscribe to webhooks for the
  tasks they started.
- **Run it standalone.** `dispatch a2a serve` puts a public A2A host in front of
  a private daemon.
- **Safe by default.**
  - Outside text is always shown as plain, fenced text.
  - Requests can't be steered to private addresses (SSRF guard with DNS
    pinning).
  - Every peer and client is tiered and revocable.
- _(planned)_ **Peer-to-peer pairing:** one code pairs two Dispatches, with
  signed requests and no shared secrets.

## Federation: a team board with no server

Teammates sync one board through a git branch you already have. There's no
central server to run, and every change is signed.

- **Signed by every machine.** Each machine has its own key. Invites, admission,
  roles and revocation are signed roster changes.
- **Agrees without a server.** Conflicting removals resolve the same way on
  every machine.
- **Survives hostile input.** Forged lines, planted symlinks, rewritten history
  and clock tricks are refused or held, never applied.
- **Upgrades gently.** A 30-day window lets teammates on older builds keep
  working while everyone upgrades.
- **Recoverable.** A recovery key gets the team back if the founder's machine is
  lost.
- **Audited.** Every roster change lands in the git receipt log.
- _(in progress)_ The desktop Machines settings: found, join, admit and resolve
  problems from the app.

## An open protocol anyone can implement

The Dispatch Messaging Protocol is published under Apache-2.0 with a full
conformance kit.

- **The spec text and registries.** Address schemes, gate types and reference
  types, each one permanent and versioned.
- **Test vectors and conformance runners.** A host can prove it's compatible.
- **Readable online** at dispatch.foo/protocol/.

## Open core

- MIT: core, client, CLI, MCP, protocol, memory, a2a.
- Apache-2.0: the protocol spec and its conformance kit.
- Elastic-2.0: federation, the team tier.
- FSL (becomes Apache-2.0 after two years): the app and the server.
