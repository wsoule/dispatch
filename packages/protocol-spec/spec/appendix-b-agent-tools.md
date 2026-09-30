# Appendix B Agent tools

This appendix is informative. It lists the tools through which agents reach DMP
in Dispatch: the same tools serve a session of a Dispatch run and an external
agent install, over the Model Context Protocol
([§1.3](01-introduction.md#s1.3)). MCP is a transport between an agent and its
host, not a DMP binding, so another host may offer different tools. Each tool
calls one of Dispatch's daemon routes
([Appendix A](appendix-a-daemon-api.md#sA)) as the agent's principal.

## B.1 Tools

The parameter names below are exactly those the tools register.

| Tool            | Parameters                                                                             | What it does                                                                                                                                                                                                                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `msg_send`      | `to`, `kind`, `body`; optional `refs`, `data`, `urgent`, `blocking`, `choices`, `wake` | Sends a message ([§4](04-messages.md#s4)) and returns the stored message, its deliveries and whether the urgent quota downgraded it. A dropped connection is retried once with the same idempotency key ([§4.9](04-messages.md#s4.9)). With `blocking` true it also waits for the answer ([§B.2](appendix-b-agent-tools.md#sB.2)).    |
| `msg_reply`     | `messageId`, `body`; optional `choice`                                                 | Replies to the message with that id: an answer when it is a question or handoff ([§4.7](04-messages.md#s4.7)), a plain message otherwise. The host decides which, and rewrites the recipients as [§4.6](04-messages.md#s4.6) says.                                                                                                    |
| `inbox_read`    | optional `state`, `limit`, `markRead`                                                  | Lists the caller's mailbox ([§7.1](07-mailboxes-and-channels.md#s7.1)), newest first, at most `limit` items (50 by default). Without `state` it lists only `held`, `notified` and `pushed` deliveries, so read mail never crowds the limit. It marks those it returns read unless `markRead` is false, and returns the ids it marked. |
| `thread_read`   | `threadId`                                                                             | Returns the messages of one thread, with their deliveries.                                                                                                                                                                                                                                                                            |
| `channel_join`  | `name`; optional `member`                                                              | Joins a channel by its bare name, without the `channel:` scheme. `member` defaults to the caller; a session joins as its work item ([§7.3](07-mailboxes-and-channels.md#s7.3)).                                                                                                                                                       |
| `channel_leave` | `name`; optional `member`                                                              | Leaves a channel, with the same default member as `channel_join`.                                                                                                                                                                                                                                                                     |
| `channel_list`  | none                                                                                   | Lists every channel and its members, the implicit `epic/<id>` channels included ([Appendix C](appendix-c-dispatch-profile.md#sC)).                                                                                                                                                                                                    |

Every tool returns its result as JSON, and escapes each line break of
[§1.4](01-introduction.md#s1.4) inside a string value, NEL, U+2028 and U+2029
included ([§6.8](06-delivery.md#s6.8)).

An external agent's tool process makes one session id when it starts and sends
it as `session` on every `msg_send` and `msg_reply`
([§4.1](04-messages.md#s4.1)). A session of a Dispatch run is one session and
sends none. A session asks to write outside its declared paths with `msg_send`,
as a `scope` gate to its human
([Appendix C](appendix-c-dispatch-profile.md#sC.3)).

## B.2 Blocking waits

A `msg_send` with `blocking` true waits for the answer by asking Dispatch's
answer route in requests of at most 45 seconds, for at most:

| Recipients                      | Longest wait                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| any `human:` address among them | 30 minutes                                                                                |
| no `human:` address             | the project's `agentBlockingTimeoutSec`: 600 seconds by default, and at most 1800 seconds |

These bounds keep a wait inside the tool timeout of the MCP client that runs a
session. When the wait ends with no answer, the tool returns the message with
`answer: null` and a note that the answer will arrive in the mailbox. The
question stays open, and a late answer still reaches the sender: pushed to a
live session, or held in its mailbox. An answer the tool does receive arrives
that usual way too, and the tool's result says where, so an agent does not act
on it twice. Dispatch denies a `scope` gate that no one decided 29 minutes after
it was sent, so a session hears the denial before its 30-minute wait ends
([Appendix C](appendix-c-dispatch-profile.md#sC.4)).

The waits are the tool's own, outside the rules a host follows, and the kit does
not test them ([§12.5](12-conformance.md#s12.5)).

## B.3 Memory tools

Four more tools read and write Dispatch's memory: the lessons, conventions and
preferences it keeps for later work. They are not DMP messages, but a shared
write reaches a human through a `memory` gate
([Appendix C](appendix-c-dispatch-profile.md#sC.3)), so they are listed here.
They use the same credentials as the tools of
[§B.1](appendix-b-agent-tools.md#sB.1) and return JSON the same way.

| Tool            | Parameters                                                                                          | What it does                                                                                                                                                                                                                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_search` | `query`; optional `scope`, `kind`, `includeStale`, `limit`                                          | Searches the entries the caller may read, at most `limit` hits (at most 50). An empty query returns the caller's top entries. Stale entries are included and marked unless `includeStale` is false.                                                                                                                                           |
| `memory_read`   | `id`                                                                                                | Returns one entry, by its handle or id: its body, who wrote it, how far it is trusted, and its revisions.                                                                                                                                                                                                                                     |
| `memory_save`   | `scope`, `kind`, `title`, `body`; optional `refs`, `epic`, `appliesTo`, `supersedes`, `projectOnly` | Saves an entry. A `personal` entry, the caller's operator's own, is saved at once. A `project` or `team` entry becomes a proposal: unless the project's autonomy policy accepts it, the system raises a `memory` gate for it, which a deciding human approves or rejects. A dropped connection is retried once with the same idempotency key. |
| `memory_forget` | `id`, `reason`                                                                                      | Retires an entry, with a one-line reason: at once for the operator's personal entry, and otherwise as a proposal, as `memory_save` does.                                                                                                                                                                                                      |
