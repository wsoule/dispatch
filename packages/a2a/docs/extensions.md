# Dispatch A2A extensions, version 1

These three extensions carry what A2A 1.0 has no field for: Dispatch addressing,
why a task is waiting on its owner, and software-work handoffs. The agent card
declares all three with `required: false`, so a plain A2A client never meets
`ExtensionSupportRequiredError` and gets the same facts as plain text in
`status.message`.

## Activation and placement

An extension is active for a request when its URI appears in the
`A2A-Extensions` header or in `message.extensions`. The response echoes the
active URIs in `A2A-Extensions`, and the server writes extension metadata only
for active extensions.

Extension data sits in `metadata[<URI>]`. On a `Message` (including
`status.message`) and on an `Artifact`, the object's `extensions` list also
names the URI. A `Task` has no `extensions` field, so task-level data lives only
in `Task.metadata[<URI>]`.

A breaking change mints a new URI ending in `/v2`.

<!-- ext:envelope -->

## Envelope: `https://dispatch.foo/a2a/ext/envelope/v1`

A profile on `Message.metadata`.

```ts
interface EnvelopeExtV1 {
  id?: string; // server to client: the Dispatch message id
  thread?: string; // server to client: the Dispatch thread id
  from?: string; // server to client: the sender's address; ignored inbound
  to?: string[]; // client to server only: recipients (default: the project owner)
  kind?: 'message' | 'question' | 'answer' | 'handoff' | 'notice';
  replyTo?: string; // a Dispatch message id the caller takes part in
  blocking?: boolean; // questions only; inbound questions always block
  choices?: string[]; // at most 20, each one line of at most 200 bytes
  choice?: string; // answers only; one of the question's choices
  refs?: { type: string; id: string }[]; // inbound: at most 50, task and message ids only
  urgent?: boolean; // inbound `true` is refused (403, URGENT_NOT_ALLOWED)
  wake?: 'none' | 'request'; // inbound 'request' is refused (403, WAKE_NOT_ALLOWED)
}
```

Inbound rules:

- `from`, `id` and `thread` are ignored: the bearer token decides who is
  sending.
- `x-` kinds are refused (403, `KIND_NOT_ALLOWED`).
- A client may address only the humans on its recipient list (by default the
  project owner) and the tasks of its own approved handoffs. Anything else is
  403, `FORBIDDEN_ADDRESS`, and the answer is the same for a teammate and a
  stranger.
- Refs name only `task` and `message` ids the caller may already see: the ids of
  its own tasks and of the messages in their scope, and the Dispatch task ids of
  its approved handoffs. No `at`. Anything else is 400 on `refs[i]`, the same
  for an absent id and a hidden one.
- Dispatch's message limits apply unchanged: body and data at most 64 KiB each;
  at most 50 recipients, 50 refs and 20 choices; refs at most 512 bytes;
  choices, a choice and a session at most 200 bytes.

Outbound, `to` is never written to a client. To a peer it names only the peer's
own address, so other recipients never leave the machine. Refs are opaque
strings as the Dispatch sender wrote them.

External data is stored wrapped under this URI, as
`{ "https://dispatch.foo/a2a/ext/envelope/v1": <value> }`, so it has no
top-level `type`; it is unwrapped when shown back to the client that sent it.

<!-- /ext:envelope -->

<!-- ext:gate -->

## Gate: `https://dispatch.foo/a2a/ext/gate/v1`

Data only, read only, on `status.message.metadata` while a task is
`TASK_STATE_AUTH_REQUIRED`.

```ts
interface GateStateV1 {
  gates: {
    id: string; // the gate's Dispatch message id
    type: 'task-proposal' | 'tool-approval' | 'scope' | 'wake';
    openedAt: string; // ISO 8601
    waitingOn: 'owner';
  }[];
}
```

Only the project owner answers a gate; a client never can. The gate's own
payload never leaves the machine (a tool approval quotes the tool's input, a
scope request names paths). `status.message` carries one fixed sentence per type
instead:

- `task-proposal`: "Waiting for the project owner to approve this handoff."
- `tool-approval`: "Waiting for the project owner to approve a tool call."
- `scope`: "Waiting for the project owner to approve a change of scope."
- `wake`: "Waiting for the project owner to approve waking the task."
<!-- /ext:gate -->

<!-- ext:work -->

## Work: `https://dispatch.foo/a2a/ext/work/v1`

A profile plus a non-terminal sub-state.

Client to server, on `Message.metadata`; it selects the skill (absent means
`ask`):

```ts
type WorkRequestV1 =
  | {
      skill: 'handoff';
      title: string; // required; one line, at most 200 bytes
      acceptance?: string[]; // at most 20 entries, each one line of at most 500 bytes
      writes?: string[]; // at most 50 repo-relative paths or globs, each at most 512 bytes
      priority?: 'urgent' | 'high' | 'medium' | 'low' | 'none'; // capped at 'medium'
      labels?: string[]; // at most 10, each at most 50 bytes; stored as 'a2a/<label>'; 'a2a' is always added
    }
  | { skill: 'status'; task?: string }; // an A2A task id; absent means all of the caller's
```

A handoff becomes a draft task the owner approves before anything runs. It
starts at the highest risk, so none of its gates decides itself. There is no
client-chosen risk.

Server to client, on `Task.metadata` and on `status.message.metadata` of a
handoff:

```ts
interface WorkStateV1 {
  task: string; // the Dispatch task id
  title: string;
  status: string; // draft, ready, working, review, landing, landed, dropped, or a custom status
  stage?: 'review' | 'landing'; // the WORKING sub-state
}
```

Server to client, on `Artifact.metadata`; `artifactId` equals `kind`:

```ts
type WorkArtifactV1 =
  | { kind: 'answer'; messageId: string; choice?: string }
  | { kind: 'pr'; url: string; number: number; state?: 'open' | 'merged' }
  | {
      kind: 'diffstat';
      files: number;
      insertions: number;
      deletions: number;
      perFile: { path: string; insertions: number; deletions: number }[]; // at most 200
    }
  | {
      kind: 'evidence';
      items: {
        command: string;
        exitCode: number;
        durationMs: number;
        summary: string;
      }[]; // at most 50
    };
```

Each artifact is at most 64 KiB as JSON; past that, `perFile` and `items` are
cut to fit and `metadata.truncated` is `true`. There is no branch artifact:
branch names and commit SHAs do not leave the machine.

<!-- /ext:work -->

## Metadata budget

All metadata on one message together is at most 64 KiB. The work extension tops
out near 36 KB (acceptance 10,000 bytes, writes 25,600, labels 500, title 200)
and the envelope near 15 KB with inbound refs restricted as above, so both fit.
Body (64 KiB), data (64 KiB), metadata (64 KiB) and framing fit the 256 KiB
request cap.

Licensed MIT; source: packages/a2a/docs/extensions.md
