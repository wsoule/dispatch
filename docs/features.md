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
  picked up again from its session, and your answer reaches the task's next run.
- **Decisions are messages.** Approvals land in one "Needs you" queue as cards:
  tool approvals, scope requests, wakes, new agents, task proposals, memory and
  doc edits. Each kind has fixed rules for who can raise it and who can answer.
- **Runs act for the human who started them.** An agent's actions are attributed
  to the person who caused the run, never to the project owner by default. A
  teammate's run asks that teammate its questions and sends them its approvals.
  When the teammate can't decide one, it goes to the project owner and the
  teammate is told.
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
- **Lessons in Settings → Memory.** Browse personal, project and team memory,
  open proposals and stale lessons in one place. Each entry shows where it came
  from, every revision and how often runs used it, with pin, confirm, promote,
  retire and delete where you're allowed to.
- **Moves with your checkout.** Moved a project to a new folder? Settings →
  Memory offers to bring the notes you kept to that project along, in one click.

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

### Pairing: two Dispatches trust each other with one code

- **One code, used once.** One side makes a short-lived pairing code, and the
  other enters it. Both sides then show the same check string to compare, and
  each pins the other's key. There are no shared secrets to copy around.
- **Signed requests both ways.** Paired agents sign every request and every
  reply, so neither side needs a bearer token, and a reply the other side didn't
  sign is never read.
- **Key rotation and revocation.** Rotate your agent's key and paired peers
  re-pin it on their own, with an overlap so nothing drops. If a key is
  compromised, revoke it and every pairing that trusted it ends.
- **Upgrade the peers you have.** A peer added with a token can move to signed
  requests once its owner confirms the fingerprint, without being re-added.
- **Unpair from either side.** Removing a paired peer tells the other side, and
  both stop.

### Reaching your agent from anywhere

- **Tailscale or Cloudflare.** Step-by-step setup for putting your agent on your
  tailnet, or behind a Cloudflare Tunnel, with no port opened.
- **Your own relay.** `dispatch a2a relay` runs a small relay on a machine you
  control. Your daemons dial out to it, and each one is reachable at its own
  address. The relay can't forge a paired peer's signed requests.

### Teammate links: no listener at all

- **Pair over a git remote you share.** Teammates who can both push to one git
  remote can pair over a branch on it. Neither side opens a port or needs a
  public address.
- **Works with laptops that sleep.** Questions, handoffs and answers wait on the
  branch, end-to-end encrypted, until the other side comes back. Links are given
  a week instead of a day.
- **The same rules as any outside agent.** Work over a link still lands as a
  draft task you approve, within the same limits.
- **Link health in Settings.** See each link's last exchange, what's waiting,
  and any problem it found.
- **Safe rules for links.**
  - Below the operator tier, a link must be an https remote on a public host.
  - Before every exchange the host is checked again, and git is pinned to the
    address that was checked: no redirects, and no proxy below the operator
    tier.
  - Whoever can push to the branch still can't forge, replay or rewrite a paired
    teammate's messages.
- _(planned)_ **Links over the team relay**, for instant delivery without git.
- _(planned)_ **Keys in the OS keychain** instead of the credentials file.

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
- **Run it from the app.** Found a team, invite, admit by fingerprint and
  resolve problems from the desktop's Machines settings.

### Messages that cross machines

- **Message any task, anywhere.** Mail to a task reaches whoever is working on
  it, on whichever teammate's machine its run lives. If no run is live yet, the
  message waits and follows the task to the next one.
- **Sealed end to end.** Message bodies are encrypted to the receiving machines,
  so the branch or relay that carries them can't read them.
- **Answers settle once.** A question asked across machines takes exactly one
  answer; late or duplicate answers are marked superseded, not applied twice.
- **See where work is happening.** Threads show which teammate's machine a
  message came from and how far it got: sent, delivered, read or answered. A
  task shows which machine its run is live on and whom it's waiting for.
- **Agents and channels are team-wide.** Approved agents and channel memberships
  sync to every machine, while each machine keeps its own gates, tokens and
  mutes.

### Memory and docs that sync with your team

- **One team memory.** Team lessons sync between machines as signed changes,
  merged field by field so two people's edits don't clobber each other.
- **Trust is checked, not claimed.** A lesson keeps "written by a human" only
  when it comes from that human's own machine; anything else arrives as agent
  written.
- **Your rules still apply.** A lesson a teammate's policy approved on its own
  still meets your project's policy, and waits for your approval if your policy
  would.
- **Docs travel too.** Team doc changes ride the same signed sync, in order,
  with who wrote them checked on arrival.

### A relay for instant sync

- **Under a second.** Switch the team from git to a relay, and messages arrive
  in under a second instead of on the next sync.
- **Told before you switch.** The app says exactly what a relay can read (the
  board, team memory and docs, the roster, and who messaged whom) and what it
  can't (message contents) before anyone confirms.
- **No machine left behind.** The switch waits until every machine runs a build
  that speaks the relay, then moves each machine's history over without losing a
  change. Switching back to git is one click.
- **Encrypted connections only.** Machines only connect to a relay over TLS.
- _(planned)_ **The hosted relay** at relay.dispatch.foo, and a self-hosted
  image.

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
