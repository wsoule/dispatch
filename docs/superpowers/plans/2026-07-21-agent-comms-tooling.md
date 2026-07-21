# Agent communication tooling — agents talk to each other and with the app

User: "we need to make tooling to make sure the agents talk to each other and
with the app." The plumbing half-exists (sendMessage = user→agent, inject =
agent→agent, run_list = discovery) but messages are recorded as undifferentiated
`system` transcript entries with no sender identity, so you can't see who is
talking to whom. Make the messaging first-class, identified, visible, and
verifiable end-to-end.

## The model

- **Agent → agent:** an agent calls the `agent_message` MCP tool → daemon
  injects the message into the target run's live session, tagged with the
  SENDER's identity. Both sender and target sessions show it.
- **App/user → agent:** the run's Session composer (already there:
  handleSendMessage → inject) — tag it `from: user`.
- **Agent → app/user:** the agent's own session output is already visible in the
  Session tab; ADD a lightweight way for an agent to raise a message to the user
  that surfaces beyond the transcript (a `message_user` MCP tool → a
  `from: agent` message entry the app can badge). Keep it small.
- **Discovery:** `run_list` (exists) lets an agent see who else is running.

## Server (packages/server)

1. `NormalizedEntry`: add `kind: 'message'` with `from: 'user' | 'agent'` and
   optional `fromLabel?: string` (who sent it — e.g. the sender run's task
   title + id for agent messages, or "you" for user). Keep the existing kinds.
2. `sendMessage(runId, text)` → record a `message` entry `{ from: 'user' }`
   (instead of the `system` "user: …" it does now); still
   `executorRun.send(text)`.
3. `inject(runId, text, from?)` → `from` is `{ runId?, label? }` describing the
   SENDER; record a `message` entry `{ from: 'agent', fromLabel }`; the text the
   agent actually receives is prefixed with the sender label
   (`[message from <label>] …`) so the receiving model knows who's talking.
4. API `POST /api/runs/:id/inject` body gains optional `fromRunId` — resolve it
   to the sender run's task title/id for the label (fall back to a generic
   label). Keep `sendMessage`'s human path as `POST /api/runs/:id/message`.
5. A new `message_user` server path is NOT needed if you route agent→user
   through a `from:'agent', toUser:true` message entry — decide the minimal
   shape; the app just needs to render/badge it.

## MCP (packages/mcp)

6. The ClaudeExecutor spawns each agent's MCP server; pass `DISPATCH_RUN_ID`
   (the agent's own run id) in that server's env so its tools know the sender.
   (executors/claude.ts sets the mcpServers env — add DISPATCH_RUN_ID alongside
   DISPATCH_PROJECT_ROOT.)
7. `agent_message` tool: read `DISPATCH_RUN_ID` from env and pass it as
   `fromRunId` to the daemon's inject, so the recipient sees who sent it. Keep
   the runId/taskId XOR target and the no-live-target error listing live runs.
8. Add `message_user(text)` MCP tool: posts a `from:'agent'` message to the user
   for this agent's own run (via a daemon endpoint), so an agent can flag a
   question/update to the human. readOnlyHint false. Small.
9. Update the `workflow://onboarding` resource to explain the three channels.

## App (apps/desktop)

10. RunLogView: render `message` entries distinctly (not as system notes) —
    `from:'user'` as "You" (accent, right-aligned bubble), `from:'agent'` as "↳
    <fromLabel>" (a distinct tint) — so the session visibly shows the
    conversation, including agent-to-agent messages.
11. The composer already sends user messages; ensure they appear as
    `from:'user'` entries immediately (optimistic or via WS).
12. All Agents view: show the live runs prominently so the user can open any
    live agent's session and talk to it (it likely already lists runs — make
    each row open the run's Session tab). Optional: a small "live messages"
    feed.

## Verification (must do end-to-end)

- Server unit tests: sendMessage records a `from:user` message entry; inject
  with a `fromRunId` records a `from:agent` entry with the resolved label; the
  API inject accepts fromRunId.
- MCP test: agent_message with DISPATCH_RUN_ID set passes fromRunId through;
  message_user posts a from:agent entry.
- Controller does a live browser demo: dispatch TWO fake runs, have one inject a
  message to the other (via the API/MCP), and confirm the message shows in the
  target's Session tab labeled with the sender. Screenshot it.

## Constraints

- Keep everything green (root build/test/tsc/format/lint; desktop test/build).
  Commit in logical chunks (server message entry + sender; mcp sender identity +
  message_user; app rendering), conventional, no AI attribution. Merge to main.
