# Appendix A Dispatch daemon HTTP and WebSocket API

This appendix is informative. It describes how Dispatch's daemon, `dispatchd`,
offers DMP to the desktop app, the command line, the agent tools of
[Appendix B](appendix-b-agent-tools.md#sB) and a teammate's browser. DMP defines
no host API ([§1.2](01-introduction.md#s1.2)), so another host may offer the
same rules through a different one. Every route below is under `/api` on the
daemon's port, takes and returns JSON, and answers a refusal as
`{ "error": <text>, "field"?: <path> }` with the HTTP status of its code
([§10.1](10-errors.md#s10.1)).

## A.1 Authentication and tiers

Every request except `GET /api/health` and signing in (`POST /api/session`, with
the token in its body) carries a credential: a bearer token
(`Authorization: Bearer <token>`), or the session cookie of a teammate's page
that the daemon served.

| Credential         | Held by                                                                                                    | Resolves to                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| app token          | the person who runs the daemon: the desktop app, and the command line given `DISPATCH_APP_TOKEN`           | the owner's `human:` address, at the `operator` tier                                       |
| team token         | a teammate, issued at a tier by `dispatch team invite`                                                     | the teammate's `human:` address, at that tier                                              |
| run token          | a session of a Dispatch run, read from the file `DISPATCH_RUN_TOKEN_FILE` names, while the run is live     | the run's `run:` address                                                                   |
| agent token        | one external agent install, returned once by `POST /api/agents/register`, valid once the agent is approved | the agent's `agent:` address                                                               |
| shared agent token | any local process that reads the daemon file, `~/.dispatch/daemons/<key>.json`                             | the `request` tier, and no sender: it may register an agent, but not send or read messages |

Most of the daemon's routes need a **tier** on a ladder of three, each holding
everything below it: `request` drives the project (a new teammate and the shared
agent token sit here), `decide` adds adjudication (answering gates, approving
agents, handing out credentials), and `operator` adds acting on the host machine
as the person who runs it (the app token sits here).

The messaging routes whose caller is "principal" below skip the ladder. They
resolve the credential to a sender
([§9.1](09-identity-and-authorization.md#s9.1)) and apply DMP's rules to it. A
human credential at the `decide` tier or above is a deciding principal
([§9.2](09-identity-and-authorization.md#s9.2)); a run or an agent never
decides. These routes refuse the shared agent token and a `pending` agent's
token with 403, and an unknown token, an ended run's token and a revoked agent's
token with 401. An A2A client's token works only on the A2A listener
([§8](08-a2a-binding.md#s8)).

## A.2 Routes

"Principal" means any sender that A.1 resolves, which the route and the engine
then check; "deciding human" means a human credential at the `decide` tier or
above. The engine calls are those of the reference implementation,
`@dispatch/protocol`.

| Method   | Path                                | Caller         | Engine call                      | Notes                                                                                                                                                                                                                                                                                                       |
| -------- | ----------------------------------- | -------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/messages`                     | principal      | `send`                           | Sends as the caller ([§4](04-messages.md#s4)); 201. An `Idempotency-Key` header is the send's idempotency key, so a repeat returns the first send with 200 ([§4.9](04-messages.md#s4.9)).                                                                                                                   |
| `GET`    | `/api/messages/:id`                 | principal      | `getMessage`, `canRead`          | One message. A caller that may not read it gets the absent id's 404, `no message <id>` ([§13.5](13-security-and-privacy.md#s13.5)).                                                                                                                                                                         |
| `POST`   | `/api/messages/:id/reply`           | principal      | `reply`                          | An answer when `:id` is a question or handoff, a plain message otherwise ([§4.7](04-messages.md#s4.7)); 201. The body is `body`, and optionally `choice`, `refs`, `data` and `session`. A non-participant gets `not-found` on `replyTo`, as for an absent id.                                               |
| `GET`    | `/api/messages/:id/answer`          | principal      | `canRead`, `answerOf`            | `{ "answer": <message or null> }` for a question or handoff, 400 for another kind, and the absent id's 404 where `GET /api/messages/:id` gives it. `?wait=1` waits up to 30 seconds for the answer, for the asker, a session acting for it, or a deciding human.                                            |
| `GET`    | `/api/threads`                      | deciding human | none: the store's recent threads | The threads with the latest messages, newest first: `?limit=` (50 by default, at most 200), and `?about=task:<id>` for the threads of one work item and its sessions.                                                                                                                                       |
| `GET`    | `/api/threads/:id`                  | principal      | `canReadThread`, `thread`        | A thread's messages and their deliveries. A caller that may read none of its messages, and every caller of a thread with no messages, gets `no message <id>` with 404, so a thread id answers as a message id does ([§9.3](09-identity-and-authorization.md#s9.3)).                                         |
| `GET`    | `/api/mailbox`                      | principal      | `inbox`                          | The caller's mailbox ([§7.1](07-mailboxes-and-channels.md#s7.1)) in delivery order; a session's also holds its work item's and the deliveries bound to the session. `?address=` reads a mailbox the caller acts for (403 otherwise), and `?state=` filters by delivery state ([§6.1](06-delivery.md#s6.1)). |
| `POST`   | `/api/deliveries/:id/read`          | principal      | `markRead`                       | Marks one delivery read, for its recipient, a caller acting for the recipient, or a deciding human.                                                                                                                                                                                                         |
| `GET`    | `/api/channels`                     | principal      | none: the store's channels       | Every channel and its members, each epic's implicit `epic/<id>` channel included ([Appendix C](appendix-c-dispatch-profile.md#sC)).                                                                                                                                                                         |
| `POST`   | `/api/channels/:name/members`       | principal      | `join`                           | Adds `member`, by default the caller, to a channel ([§7.3](07-mailboxes-and-channels.md#s7.3)); a session joins as its work item; 204. Adding another address needs a caller that acts for it.                                                                                                              |
| `DELETE` | `/api/channels/:name/members`       | principal      | `leave`                          | Removes the caller, a session as its work item; 204, or 404 when it is not a member.                                                                                                                                                                                                                        |
| `DELETE` | `/api/channels/:name/members/:addr` | principal      | `leave`                          | Removes `:addr` for a caller that acts for it; 204, or 404 when it is not a member.                                                                                                                                                                                                                         |
| `GET`    | `/api/agents/roster`                | `request` tier | none: the store's agents         | Every registered agent with its status and whether it is muted, never its token.                                                                                                                                                                                                                            |
| `POST`   | `/api/agents/register`              | `request` tier | `send`                           | Registers `agent:<handle>/<name>` as `pending`, where `<handle>` is the requesting human's, and the system raises the `agent-registration` gate to the owner ([Appendix C](appendix-c-dispatch-profile.md#sC.3)). The body is `name` and `client`; 201 returns the agent's token, once.                     |
| `POST`   | `/api/agents/:addr/approve`         | `decide` tier  | `reply`                          | Approves the agent, as the answer to its open registration gate when there is one.                                                                                                                                                                                                                          |
| `POST`   | `/api/agents/:addr/revoke`          | `decide` tier  | `reply`                          | Revokes the agent the same way. Its token stops working, and a revoked A2A client's open asks close.                                                                                                                                                                                                        |
| `POST`   | `/api/agents/:addr/mute`            | `decide` tier  | none: the agent's record         | Mutes the agent ([§6.7](06-delivery.md#s6.7)).                                                                                                                                                                                                                                                              |
| `POST`   | `/api/agents/:addr/unmute`          | `decide` tier  | none: the agent's record         | Ends the mute.                                                                                                                                                                                                                                                                                              |
| `GET`    | `/api/decisions/open`               | deciding human | `openBlocking`                   | The open blocking questions addressed to a human, gates included.                                                                                                                                                                                                                                           |

The read routes (`GET /api/messages/:id`, its answer route and
`GET /api/threads/:id`) apply the read rule through the engine's `canRead` and
`canReadThread`, and answer a caller that may not read exactly as they answer an
id that does not exist ([§13.5](13-security-and-privacy.md#s13.5)). The kit
tests the rule, not these routes ([§12.5](12-conformance.md#s12.5)).

The rest of the daemon's API (work items, runs, reviews, and the A2A bridge's
administration under `/api/a2a/`) is outside DMP and this appendix.

## A.3 Events

A client with a `request`-tier credential opens a WebSocket at `/ws`. A browser
cannot set headers on one, so the token may also be the `token` query parameter.
The daemon sends each event as one JSON object with a `type`. Two events carry
messaging:

| Event              | Members                       | Sent when                                                                                       |
| ------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `message.new`      | `message`, the stored message | a message is stored                                                                             |
| `delivery.changed` | `deliveryId`, `messageId`     | a delivery changes state ([§6.1](06-delivery.md#s6.1)); a client re-reads the thread to see how |

The daemon sends both only to sockets whose credential may read the message
([§9.3](09-identity-and-authorization.md#s9.3)): a human credential at the
`decide` tier or above, or one whose address sent the message, is in its `to`,
or holds one of its deliveries. Sockets opened with the shared agent token
receive neither.
