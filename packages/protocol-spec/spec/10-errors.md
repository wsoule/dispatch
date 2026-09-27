# 10 Errors

Every refusal in this document is one error with a **code** and, in most cases,
a **field**. A host that fails an operation performs none of it; for a send,
that means it stores no message and no delivery of its own
([§4.5](04-messages.md#s4.5)).

## 10.1 Codes

| Code        | HTTP status | Meaning                                                                      | For example                                                                                                       |
| ----------- | ----------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `invalid`   | 400         | the input breaks a rule of this document                                     | a malformed address, a limit exceeded, a gate type the host does not implement, a direct send to an ended session |
| `forbidden` | 403         | the sender may not do this                                                   | an agent that is not approved, raising or answering a gate without the authority                                  |
| `not-found` | 404         | what the input names does not exist, or the sender may not know that it does | a `replyTo` naming an absent or foreign message, an unknown channel, an unknown delivery                          |
| `conflict`  | 409         | the current state does not allow it                                          | a second answer to a question                                                                                     |
| `limited`   | 429         | a guardrail refused it                                                       | a reply into a thread that reached the breaker's limit ([§6.6](06-delivery.md#s6.6))                              |

A host that speaks HTTP answers each code with its status. A binding carries the
code, or maps it onto its own error model as its section says. The registry of
codes is [§11.9](11-registries.md#s11.9).

## 10.2 Fields

`field` names the part of the caller's input that failed, as a path: a member
name (`to`, `kind`, `body`, `data`, `replyTo`, `choice`), a list index in
brackets (`to[1]`, `choices[2]`) and a member of an entry or object after a dot
(`refs[0].type`, `data.type`, `data.paths`). `from` names the sender, and
operations other than a send name their own inputs (`member` for a join). An
error about a recipient names the caller's own `to[i]`, as the sender wrote the
list ([§3.5](03-addresses.md#s3.5)).

An error's text is not normative and the kit never compares it. A host SHOULD
make it say how to fix the input, since the sender is often an agent that will
retry.

## 10.3 Unknown codes

A later minor version may add an error code ([§14.1](14-versioning.md#s14.1)). A
client MUST treat a code it does not recognize as the class of its HTTP status:
a 4xx code as a refusal of this request, a 5xx code as a failure of the host
that may pass.

`unavailable` (503) is an informative code: a store or service the host needs is
down. Hosts and bindings raise it; the rules of this document never do.
