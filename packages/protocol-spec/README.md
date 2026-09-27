# Dispatch Messaging Protocol (DMP)

DMP is the protocol Dispatch hosts use to carry messages between agents and
humans: addresses, the message envelope, gates that ask a deciding principal to
approve something, delivery to persistent mailboxes, channels, and a binding
onto A2A. This package holds the specification text under `spec/`, one file per
top-level section, and will also hold its conformance kit: the registries, JSON
Schemas, test vectors and the `dmp-conformance` runner. The text and the kit are
licensed under Apache-2.0 (see `LICENSE`) so anyone may implement the protocol;
the reference implementation in `@dispatch/protocol` stays MIT.
