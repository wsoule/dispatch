# Appendix F Federation wire and receive

This appendix is informative, and tracks Dispatch's federation design. It
describes how the hosts of teammates exchange messages: each host is a
**replica**, one project on one machine, and the replicas of a team publish
signed operations to a shared transport, such as a git branch or a relay, and
apply each other's. It becomes normative in a later 1.x minor version, together
with the `federation` vector class, once two transports implement it
([§1.3](01-introduction.md#s1.3), [§12.1](12-conformance.md#s12.1)).

Until then its registry entries (the envelope fields `origin` and `hlc`, and the
delivery states `forwarded` and `refused`) have the status `appendix`
([§11.11](11-registries.md#s11.11)): a host that does not implement this
appendix never emits them, and ignores them on input. The character `@` stays
reserved in addresses for a later authority qualifier
([§3.3](03-addresses.md#s3.3)).

Every binary value below is base64url without padding, and every hash is
SHA-256, written as lowercase hex.

## F.1 FederatedOp

Every change a replica publishes is one op: a small header that its publisher
signs, and the content the header commits to by hash. An op whose content was
pruned keeps a stub that still verifies.

```ts
type OpType =
  | 'key'
  | 'roster'
  | 'task'
  | 'presence'
  | 'agent'
  | 'channel'
  | 'mail'
  | 'state'
  | 'memory'
  | 'doc';

interface OpHeader {
  v: 2;
  replica: string; // the publisher
  seq: number; // strictly increasing along the publisher's chain; may skip values
  prev: string; // the opHash of the publisher's previous op; 64 zeros on its key op
  hlc: string; // `<ms>.<counter>.<replica>`, strictly increasing along the chain
  type: OpType;
  to?: string[]; // sealed types only: the recipient replicas, sorted, 1 to 256
  bodyHash: string; // the hash of JCS({ body?, sealed? })
}

interface FederatedOp extends OpHeader {
  body?: JsonValue; // the plain types, and the clear part of a forward
  sealed?: Sealed; // mail and state (F.3)
  sig: string; // Ed25519 over "dispatch-op-v2\n" + JCS(the header)
}

// What replaces an op a transport pruned: the header and its signature.
interface OpStub extends OpHeader {
  sig: string;
  pruned: true;
}
```

- **Replicas and keys.** A replica id matches
  `^[A-Za-z0-9._-]{1,32}-[0-9a-f]{8}$`; an op or key naming another is refused.
  Each replica has an Ed25519 signing key
  ([RFC 8032](https://www.rfc-editor.org/rfc/rfc8032)) and an X25519 sealing key
  ([RFC 7748](https://www.rfc-editor.org/rfc/rfc7748)), announced in its `key`
  op, the first op of its log. Keys never rotate in place: a replica that loses
  them starts over under a new id.
- **Verification.** An op verifies when `sig` verifies over its header with the
  publisher's key and `bodyHash` is the hash of its content. A stub verifies
  with the same signature, and is accepted only for the types `mail`, `state`
  and `presence`.
- **The chain.** `opHash` is the hash of the JCS form of the header and `sig`,
  the same for an op and its stub. Each op carries the `opHash` of the
  publisher's previous op as `prev`, and its `seq` exceeds that op's. A
  rewritten or forked log fails to verify, and halts at the op that fails.
- **The clock.** An op's `hlc` names its own replica after the second dot, and
  exceeds the previous op's, comparing milliseconds and counter as numbers. A
  replica adopts the latest clock it accepts, up to 5 minutes ahead of its own
  wall clock.
- **Size.** A serialized op is at most 1 MiB, a sealed op names at most 256
  recipients, and a state op carries at most 500 entries. A message always fits,
  since its body and data are at most 64 KiB each ([§4.5](04-messages.md#s4.5)).
- **Unknown types.** An op of a type a replica does not know is verified, kept,
  and applied after an upgrade that knows it.

| Type       | Content                                                          | Who may publish                                                                                   | Applied by           |
| ---------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------- |
| `key`      | the replica's handle, device, build and public keys              | the replica itself, once, as its first op                                                         | every replica        |
| `roster`   | admissions, roles, revocations, invites and the license          | by role                                                                                           | every replica        |
| `task`     | a change to a work item                                          | any admitted replica                                                                              | every replica        |
| `presence` | the replica, or one of its sessions, is live                     | the replica, for itself and its own sessions                                                      | every replica        |
| `agent`    | an agent install registered on the replica                       | the replica it registered on                                                                      | every replica        |
| `channel`  | one membership change                                            | any admitted replica                                                                              | every replica        |
| `mail`     | a sealed message ([§F.4](appendix-f-federation.md#sF.4))         | any admitted replica, for the senders it speaks for ([§F.5](appendix-f-federation.md#sF.5))       | the replicas in `to` |
| `state`    | sealed delivery states, settlements and refusals                 | a home of each recipient it reports; a question's origin for a settlement; a replica that refused | the replicas in `to` |
| `memory`   | a team memory entry ([§F.7](appendix-f-federation.md#sF.7))      | any admitted replica                                                                              | every replica        |
| `doc`      | a team document revision ([§F.7](appendix-f-federation.md#sF.7)) | any admitted replica                                                                              | every replica        |

Only `mail` and `state` are sealed. The other types are the team's shared state
and travel in the clear, so a transport can read the board, team memory and
documents, presence and the roster, but not the mail.

## F.2 Canonical JSON and domain tags

**Canonical JSON** is [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) (JCS):
object keys sorted by UTF-16 code units, and strings and numbers written exactly
as ECMAScript's `JSON.stringify` writes them. Non-finite numbers are refused. It
is the serialization that measures the size of `data`
([§1.4](01-introduction.md#s1.4)).

**Domain tags.** Every signature and seal starts its input with its own tag and
a line feed, so that none can be replayed as another:

| Tag                    | Signs or seals                      |
| ---------------------- | ----------------------------------- |
| `dispatch-op-v2`       | every op header                     |
| `dispatch-sealed-v1`   | sealed payloads and their key wraps |
| `dispatch-ack-v1`      | a transport's acknowledgements      |
| `dispatch-relay-v1`    | a relay's connection challenge      |
| `dispatch-invite-v1`   | an invited key's proof              |
| `dispatch-recovery-v1` | an admin's recovery proof           |
| `dispatch-fp-v1`       | fingerprints                        |

**Fingerprints**, which people compare out of band, are the first 15 bytes of
the hash of `"dispatch-fp-v1\n" + signPub + "\n" + sealPub`, over the base64url
public keys, in Crockford base 32, printed in six groups of four characters.

## F.3 Sealing

```ts
interface Sealed {
  nonce: string; // 12 random bytes
  ct: string; // AES-256-GCM(K, nonce, JCS(payload), aad), the 16-byte tag appended
  keys: Record<string, { enc: string; ct: string }>; // K sealed to each replica in `to`
}
```

- **The payload** is encrypted once, under a random 32-byte key `K`, with `aad`
  `"dispatch-sealed-v1\n" + replica + "\n" + seq + "\n" + type`, so a ciphertext
  cannot move into another op.
- **The key** is wrapped for each recipient with single-shot
  [HPKE](https://www.rfc-editor.org/rfc/rfc9180) in base mode, with
  DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and AES-256-GCM; the recipient's
  sealing key as `pkR`; `info` set to `aad + "\n" + <recipient replica>`; and an
  empty HPKE `aad`. The keys of `keys` are exactly `to`.
- **In the clear** are the header (the recipients, the publisher, `seq`, `hlc`,
  the type and `bodyHash`) and sizes: all a transport needs to route,
  de-duplicate and prune.
- **Who can read.** Only the recipients can unwrap `K`, and the op's signature
  binds the ciphertext to its publisher, so a recipient cannot publish the
  payload again under another replica's name.

## F.4 Mail and state payloads

```ts
interface MailPayload {
  message: Message; // as stored at its origin, `hlc` included, `origin` left out
  targets: MailTarget[]; // the origin's resolution of `to`
}

interface MailTarget {
  recipient: Address;
  via: 'direct' | 'channel';
  homes: string[]; // the replicas that deliver it
  wakeAt?: string; // for a work item of a wake request: the one replica that may wake it
}

// A forward: a `mail` op whose body is { forward: <the original op, verbatim> },
// sealed to one replica, with this payload:
interface ForwardPayload {
  target: Address; // one of the original's targets
  key: string; // the original op's content key K
}

interface StatePayload {
  entries: (
    | {
        t: 'delivery';
        message: string;
        recipient: Address;
        state: 'held' | 'pushed' | 'notified' | 'read' | 'answered';
        at: string;
      }
    | {
        t: 'settle';
        question: string;
        answer: string; // the accepted answer's id, or the close's
        closed?: string; // set when the origin closed the question
        at: string;
      }
    | {
        t: 'refused'; // this home refused a message (F.5)
        message: string;
        reason: string; // the error's code and message
        at: string;
      }
  )[];
}
```

- **The origin** of a message is the replica that created it: a `mail` op's
  publisher, or a forward's inner op's. A forward keeps the original op, and
  with it the original signature, so authorship survives forwarding.
- **The origin's resolution is final.** Receivers never expand a channel again,
  so a partition cannot give two replicas different recipients, and the origin
  names in `wakeAt` the one replica that may wake each work item.

**Envelope fields.** A message received from another replica is stored with two
fields besides those of [§4.1](04-messages.md#s4.1):

| Field    | Meaning                                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `origin` | the replica that created the message; absent on a message created here                                                      |
| `hlc`    | the origin's hybrid clock when it sent the message, `<ms>.<counter>.<replica>`; a replica sets it on every message it sends |

Neither is part of a send input, and validation ignores them. A thread is
ordered by `hlc`, then by id, and messages that have no `hlc` sort first, so a
reply sorts after its question whatever the machines' clocks say; `createdAt` is
for display.

**Delivery states.** A recipient whose homes are other replicas gets a remote
row instead of a delivery ([§6](06-delivery.md#s6)). Besides the states of
[§6.1](06-delivery.md#s6.1), a remote row may be:

| State       | Meaning                                                                                 |
| ----------- | --------------------------------------------------------------------------------------- |
| `forwarded` | handed to the transport for the recipient's homes, with no report yet                   |
| `refused`   | every home of the recipient refused the message ([§F.5](appendix-f-federation.md#sF.5)) |

A remote row's state is the highest its homes report, in the order `held`, then
`pushed` or `notified`, then `read`, then `answered`; `sending` is never
reported. `refused` holds only while every home of the recipient has refused,
and any later report from a home replaces it. A home reports the states of its
deliveries in `state` ops sealed to the message's origin and to every replica
the message went to, and an entry counts only from a replica that homes the
recipient.

## F.5 Receive

**Homes.** Every address has **homes**: the replicas that store and deliver its
mail, computed from the replicated roster, presence and agent ops, so that every
replica computes the same ones.

| Address                                                 | Homes                                                                                                 |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `human:<handle>`                                        | every admitted replica of that handle, and every replica that hosts it                                |
| `task:<id>`                                             | the replica whose presence shows a live session of the work item; otherwise the homes of its assignee |
| `agent:<operator>/<name>`                               | the replica it registered on                                                                          |
| `channel:<name>`                                        | expanded to its members first, then each member's homes                                               |
| `run:<id>`                                              | none: a reply to a remote session's message goes to that message's origin                             |
| the system address, A2A clients and peers, the overseer | never federated                                                                                       |

An address with no homes stays local.

**What never leaves.** A message is **local-only** when it or its stored
`replyTo` target has gate data ([§5.1](05-gates.md#s5.1)), tested for gate data
alone, whatever its type and whether the host knows it; when its `data.type` is
a marker (`x-closed`, `x-breaker`, and the Dispatch profile's `x-policy` and
`x-expired`); when a participant is the overseer, an A2A client or an A2A peer;
or when its thread's root is local-only. A send that would carry a local-only
message to another replica fails: `forbidden` on `data` when it has gate data,
and otherwise `forbidden` on the `to[i]` of a direct recipient homed elsewhere.
So gate data never leaves a host through federation ([§5.8](05-gates.md#s5.8),
[§13.9](13-security-and-privacy.md#s13.9)), and no gate is decided across hosts.

**Speaks for.** A `mail` op's origin may carry a message whose `from` is a
`human:` address of its own handle or one it hosts, a session bound to it by
presence, an agent it registered, or the system address, for a notice with no
`data` whose refs name a message it exchanged with this replica. A message from
the system address of another replica is an ordinary agent-authored message
here, never the system. Any other `from` is dropped.

**Receiving.** A replica applies a `mail` op addressed to it in this order,
after it has verified the op, its chain and the speaks-for rule, and decrypted
the payload:

1. **Duplicate.** A message whose id is stored with the same content is a
   duplicate; one with other content is refused as an id collision.
2. **Local-only.** Refuse local-only content, tested as above on the message and
   on its stored `replyTo` target.
3. **Authorize the sender.** A remote agent must be approved in the replicated
   agent rows.
4. **Participation.** When the `replyTo` target is stored here, the sender must
   participate in it ([§4.6](04-messages.md#s4.6)), counting remote rows too.
   When it is not stored here, the thread is partial on this replica: the sender
   must participate in the thread's root when that is stored here, and otherwise
   the message is accepted.
5. **Validate** the message as received ([§4.4](04-messages.md#s4.4)), with
   `canDecide` false, so no remote sender decides, and a received ref of an
   unknown identifier type is kept. When the reply target is missing, the checks
   that need it are skipped.
6. **The breaker and the urgent quota** ([§6.6](06-delivery.md#s6.6)), counted
   by arrival time, so a sender cannot escape them by backdating `createdAt`.
7. **Answers** settle at the question's origin
   ([§F.6](appendix-f-federation.md#sF.6)).
8. **Plan** each target: one whose homes include this replica is planned as a
   local send's would be ([§6.1](06-delivery.md#s6.1)); every other gets a
   remote row, `forwarded`. A muted sender's deliveries start `read`.
9. **Commit** the message, with `origin`, `hlc` and its arrival time, its
   deliveries and its remote rows in one transaction, then push and notify as a
   send does ([§6.3](06-delivery.md#s6.3)).
10. **Wake** a held work item of a wake request only on the replica `wakeAt`
    names, under that replica's own wake policy ([§6.5](06-delivery.md#s6.5)),
    which treats a remote human's wake as an agent's.

A refusal in steps 1 to 6 stores nothing. The refusing replica sends the origin
a `refused` state entry; when every home of a recipient has refused, the origin
sets that recipient's remote row to `refused` and sends the sender a notice.

**Presentation.** A pushed message from another replica names its sender with
`(remote: <handle>)`, and every line after its header is quoted, as for an
external sender ([§6.8](06-delivery.md#s6.8)).

## F.6 Settlement

A question takes one answer ([§4.7](04-messages.md#s4.7)) across replicas too.
The **settler** of a question is its origin, the replica it was created on.

- **At the settler**, the first answer it applies, local or remote, is the
  answer. It publishes a `settle` entry naming it to the homes of every
  participant of the question and the answer. A later local answer fails
  `conflict`; a later remote one is kept as a reply, of kind `message`, and its
  sender is told the question was already answered. Every close by the settler
  is published the same way, with `closed` set, and only the settler closes a
  question.
- **Elsewhere**, the first answer seen is kept as the answer, pending, and later
  ones as candidate replies. Answers seen before their question are checked
  against it when it arrives: the first that passes participation and the checks
  that need the question stays the answer, and the rest are candidates. A
  `settle` entry makes the accepted answer the answer, every other a reply, and
  the question's deliveries `answered`, in one transaction; one that arrives
  before its answer waits for it. A `settle` with `closed` writes the close
  here. A `refused` entry for a local answer turns it back into a reply and
  reopens the question's deliveries it had answered.
- **Only the settler is believed.** A `settle` entry from any other replica is
  refused.

No gate effect runs on a settlement, since gates never cross hosts
([§F.5](appendix-f-federation.md#sF.5)).

## F.7 Team memory and doc ops

**Memory.** A `memory` op carries one team memory entry:

```ts
interface MemoryBody {
  memory: string; // `mem-` and a ULID
  kind: 'put' | 'remove';
  fields?: Record<string, unknown>; // the entry's fields
  trust: 'human' | 'confirmed' | 'agent'; // the publisher's claim; receivers recompute it
}
```

- Only `team` entries travel, active or retired, merged field by field, the
  later `hlc` winning. Proposals and their `memory` gates, personal and project
  entries, and recall history stay on their replica.
- A receiver recomputes trust: `human` stands when the publisher speaks for the
  entry's human author, `confirmed` when it speaks for the human who decided it,
  and anything else arrives as `agent`. A change to an entry's content sets its
  trust by these rules; any other change never lowers the trust a replica
  already holds.
- The receiver's own memory policy still applies: an entry it would not accept
  arrives as an open proposal there.

**Docs.** A `doc` op carries one revision of a team document, as Dispatch's
documents design defines it: the document's id, `put` or `remove`, the author
(`by`), and an optional revision and metadata. A receiver checks the author
against what the publisher speaks for, keeps a revision whose parents have not
arrived until they do, and applies a revision in clock order. A revision fits
one op.
