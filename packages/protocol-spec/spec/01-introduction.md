# 1 Introduction

Agents already talk to services through request and response protocols such as
[A2A](https://a2a-protocol.org). What those protocols leave out is the part a
team of humans and agents needs to work together over days: mail that waits for
a recipient who is not running, channels, humans as peers of agents, and the
work a message is about. DMP defines that part. It was extracted from a working
implementation, Dispatch, whose reference engine is MIT-licensed, and it speaks
A2A at the edge ([§8](08-a2a-binding.md#s8)) rather than competing with it.

## 1.1 Goals

- **One address grammar** for people, agents, units of work, running sessions
  and channels ([§3](03-addresses.md#s3)).
- **Persistent messages.** A message is stored once, each recipient gets a
  delivery with its own state, and nothing a host has accepted is lost across a
  restart ([§4](04-messages.md#s4), [§6](06-delivery.md#s6)).
- **Mailboxes.** Mail to a work item that has no running session waits for its
  next session, which receives it when it starts ([§6.4](06-delivery.md#s6.4),
  [§7](07-mailboxes-and-channels.md#s7)).
- **Humans as peers.** Humans send, receive and answer like agents, and only
  humans the host authorized, or the host itself, decide
  ([§9](09-identity-and-authorization.md#s9)).
- **Decisions as data.** Gates ask a deciding principal to approve an action
  before the host applies it; a gate of a type a host does not know fails closed
  ([§5](05-gates.md#s5)).
- **Safe presentation.** A message put in front of a model can never pass for
  text the host wrote ([§6.8](06-delivery.md#s6.8)).
- **Checkable conformance.** Language-neutral test vectors and a runner check
  what an implementation claims ([§12](12-conformance.md#s12)).

## 1.2 Non-goals

- **Task storage.** How a host stores, schedules and runs its work items, and
  what fields they have, is the host's business. DMP needs only the facts listed
  in [§2.1](02-terminology.md#s2.1).
- **Memory.** Dispatch's memory entries and their store are not wire format.
  Their gate type is registered ([§11.6](11-registries.md#s11.6)).
- **A relay** between hosts, and a normative federation wire before two
  independent transports implement one
  ([Appendix F](appendix-f-federation.md#sF)).
- **A normative host API.** [Appendix A](appendix-a-daemon-api.md#sA) describes
  Dispatch's daemon API for information only.
- **Authentication.** How a host authenticates its principals is out of scope
  ([§9.1](09-identity-and-authorization.md#s9.1)).
- **Roles.** A later version may model a role as a channel whose membership the
  role manages.

## 1.3 Relation to A2A, MCP and federation

- **A2A.** A2A connects an agent to a service over request and response. DMP
  hosts meet A2A clients and peers at the edge: [§8](08-a2a-binding.md#s8) maps
  DMP messages onto A2A messages and tasks, and defines three A2A extensions,
  `https://dispatch.foo/a2a/ext/envelope/v1`,
  `https://dispatch.foo/a2a/ext/gate/v1` and
  `https://dispatch.foo/a2a/ext/work/v1`. Gate data never crosses a binding
  ([§5.8](05-gates.md#s5.8)).
- **MCP.** Agents inside a host's sessions usually reach DMP through tools that
  the host offers over the Model Context Protocol. MCP is a transport between an
  agent and its host, not a DMP binding;
  [Appendix B](appendix-b-agent-tools.md#sB) lists Dispatch's tools for
  information.
- **Federation.** Messages between the hosts of teammates are described in
  [Appendix F](appendix-f-federation.md#sF) for information. It becomes
  normative in a later minor version, once two transports implement it. Until
  then its registry entries have the status `appendix`, the `federation` vector
  class is reserved, and the character `@` is reserved in addresses
  ([§3.3](03-addresses.md#s3.3)).

## 1.4 Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this
document are to be interpreted as described in BCP 14
([RFC 2119](https://www.rfc-editor.org/rfc/rfc2119),
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174)) when, and only when, they
appear in all capitals, as shown here.

- **JSON** is as in [RFC 8259](https://www.rfc-editor.org/rfc/rfc8259); strings
  are Unicode. Every length in this document is a count of UTF-8 bytes, and 1
  KiB is 1024 bytes.
- **The size of `data`** is the UTF-8 length of its
  [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) (JCS) serialization. JCS
  serializes numbers and strings as ECMAScript does, and key order does not
  change the length, so this equals the length of ECMAScript's `JSON.stringify`
  of the same value.
- **Timestamps** are [RFC 3339](https://www.rfc-editor.org/rfc/rfc3339) times in
  UTC, in the fixed 24-character form `YYYY-MM-DDTHH:MM:SS.sssZ`, because hosts
  compare them as strings.
- **Line breaks** are CRLF, LF, CR, VT (U+000B), FF (U+000C), NEL (U+0085), LINE
  SEPARATOR (U+2028) and PARAGRAPH SEPARATOR (U+2029). A value is **one line**
  when it contains none of them. Text is split into lines at every one of them.
- **Blank** means empty after removing, from both ends, the characters of
  ECMAScript's `String.prototype.trim`: U+0009 to U+000D, U+0020, U+00A0,
  U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF.
  The set is spelled out because other languages define whitespace differently;
  NEL is not in it.
- **Identifiers** match `[a-z0-9][a-z0-9._-]*` and are at most 64 bytes.
- **Message and delivery ids** are identifiers, unique across hosts, that sort
  bytewise in creation order within one host. `m-` (messages) or `d-`
  (deliveries) followed by a lowercase [ULID](https://github.com/ulid/spec) is
  RECOMMENDED, and is what the Dispatch profile uses.
  [§13.7](13-security-and-privacy.md#s13.7) sets their entropy.
- **Patterns** are ECMAScript regular expressions. A pattern this document
  writes matches a whole value. The render patterns a host declares (`header`
  and `hostLines`, [§6.8](06-delivery.md#s6.8)) are searched instead, as
  `new RegExp(pattern).test(line)` does: each matches anywhere in the line
  unless it anchors itself with `^` or `$`.
- **Names of fields** are the JSON member names of [§4.1](04-messages.md#s4.1),
  written in `code`. A path such as `refs[0].type` names a member of a list
  entry ([§10.2](10-errors.md#s10.2)).
- **Examples** use the Dispatch profile's id forms (`t-4a8cce` for a work item,
  `r-9f2c01` for a session) and are informative.
- **Normative sources** are this text and the test vectors
  ([§12.4](12-conformance.md#s12.4)). Where they disagree, the text governs and
  the disagreement is an erratum, fixed in a patch release that corrects the
  vector ([§14.1](14-versioning.md#s14.1)). The JSON Schemas
  ([Appendix D](appendix-d-json-schemas.md#sD)) are informative, because JSON
  Schema cannot count UTF-8 bytes or express the one-line rule.
- **Pinned rules.** Sixteen rules of this document are stated exactly because a
  second implementation would otherwise have to guess them. Each is marked
  "(pinned rule N)", and the mark names the vectors that test it once they
  exist.
