# 3 Addresses

Every sender and recipient is an address: a scheme, a colon, and a part whose
form the scheme defines. Addresses are compared as strings.

```text
human:wyat                  agent:wyat/claude-code.macbook      actors
task:t-4a8cce               run:r-9f2c01                        work
channel:auth-refactor       channel:epic/e-c25f9c               many-to-many
```

## 3.1 Grammar

An **identifier** matches `[a-z0-9][a-z0-9._-]*`
([§1.4](01-introduction.md#s1.4)). Handles, operators, ids and channel name
segments are identifiers.

| Form                             | Scheme    | Parts                                                                   |
| -------------------------------- | --------- | ----------------------------------------------------------------------- |
| `human:<handle>`                 | `human`   | the human's handle                                                      |
| `agent:<handle>`                 | `agent`   | the agent's handle                                                      |
| `agent:<operator>/<handle>`      | `agent`   | the handle of the human who operates the agent, then the agent's handle |
| `task:<id>`                      | `task`    | the work item's id                                                      |
| `run:<id>`                       | `run`     | the session's id                                                        |
| `channel:<segment>(/<segment>)*` | `channel` | the channel's name: one or more segments joined by `/`                  |

A host MUST refuse, as `invalid` on the field that carried it
([§10.2](10-errors.md#s10.2)), a string that has no colon or nothing before its
first colon, that names a scheme the host does not implement, or whose part does
not have its scheme's form.

A host MAY narrow the grammar of work item and session ids, and then MUST refuse
an id outside its narrower grammar as `invalid` in the same way. The Dispatch
profile narrows them to `[te]-[0-9a-f]{6,12}` and `r-[0-9a-f]{6,12}`
([Appendix C](appendix-c-dispatch-profile.md#sC.1)).

A host reports a parsed address as its `kind` (the scheme), its parts by name
(`handle`, `operator`, `id` or `name`; `operator` is null for an agent without
one) and the `address` itself. The conformance kit reads this form
([§12.4](12-conformance.md#s12.4)).

## 3.2 Limits

An address is at most 256 bytes, and each handle, operator, id and channel name
segment in it is at most 64 bytes. A host MUST refuse a longer address or part
as `invalid` on the field that carried it. With the limit of 50 recipients
([§4.5](04-messages.md#s4.5)), these bound the addresses of one send for every
host, binding and receiver.

A host that derives handles from other names, such as email local parts, keeps
the handles it derives within 64 bytes, so that every address it assigns is
valid everywhere.

## 3.3 Reserved characters

`@` is reserved for a federation authority qualifier
([§11.2](11-registries.md#s11.2)). The grammar of [§3.1](03-addresses.md#s3.1)
already excludes it, so a host refuses an address that contains it, and a host
MUST NOT assign an address that contains it.

## 3.4 Schemes

| Scheme    | Stands for                                                                                                                                      | Receives mail                                                                                                                                                      |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `human`   | a person                                                                                                                                        | through the host's notifier ([§6.1](06-delivery.md#s6.1))                                                                                                          |
| `agent`   | a registered agent install; every session of the install shares its mailbox, and `session` records which one sent ([§4.1](04-messages.md#s4.1)) | held in its mailbox                                                                                                                                                |
| `task`    | a work item ([§2.2](02-terminology.md#s2.2))                                                                                                    | pushed or notified in its live session ([§6.2](06-delivery.md#s6.2)), or held for its next one                                                                     |
| `run`     | exactly one session                                                                                                                             | pushed or notified while it is live ([§6.2](06-delivery.md#s6.2)); a direct send to one that is not live fails, with the exceptions of [§6.1](06-delivery.md#s6.1) |
| `channel` | a named group ([§7.2](07-mailboxes-and-channels.md#s7.2))                                                                                       | never: a channel expands to its members ([§3.5](03-addresses.md#s3.5))                                                                                             |

The A2A binding adds the scheme `a2a` for outbound peers
([§8.9](08-a2a-binding.md#s8.9)). The registry of schemes is
[§11.1](11-registries.md#s11.1); adding a scheme is a major change
([§14.1](14-versioning.md#s14.1)).

## 3.5 Resolution

A host resolves a send's `to` list into targets, each a recipient and the route
that reached it:

1. A reply's `to` list is first rewritten as [§4.6](04-messages.md#s4.6) says,
   which can turn an ended session into its work item and make two entries
   equal.
2. Each entry that is not a channel is a target with the route `direct`.
3. A channel expands to its explicit members, then its implicit members
   ([§3.6](03-addresses.md#s3.6)), each a target with the route `channel`. A
   stored member that is itself a channel is skipped
   ([§7.3](07-mailboxes-and-channels.md#s7.3)).
4. Targets are de-duplicated ([§3.7](03-addresses.md#s3.7)).
5. The sender, the work item of a sending session, and the system address are
   dropped: none of them gets a delivery.
6. Each remaining target gets its initial state and session
   ([§6.1](06-delivery.md#s6.1)).

A channel that has never had a member joined and has no implicit members is
unknown. A send naming an unknown channel MUST fail `not-found` on the caller's
own `to[i]`: `i` is the index of the channel in the `to` list the sender wrote,
even when the rewriting of step 1 changed or collapsed other entries. Every
other error about a recipient likewise names the first `to[i]`, as the sender
wrote it, that resolved to that recipient. (pinned rule 2; vectors:
`core.send.unknown-channel-names-the-callers-own-slot`,
`core.send.an-ended-session-error-names-the-callers-own-slot`,
`core.send.unknown-channel-is-not-found`)

## 3.6 Implicit members

A host MAY compute some channels' members when a message is sent, instead of
storing them. Implicit members are added after the explicit ones and
de-duplicated with them. The Dispatch profile computes the members of
`channel:epic/<id>` as the work items under that epic
([Appendix C](appendix-c-dispatch-profile.md#sC)). Vectors that test implicit
members are `MAY` vectors with the capability `implicit-members`
([§12.2](12-conformance.md#s12.2)).

## 3.7 De-duplication

A recipient reached more than once by one send gets exactly one delivery. When
it was reached both directly and through a channel, the delivery's route is
`direct`; otherwise it is the route that reached it. The order of a message's
deliveries has no meaning.
