# 14 Versioning, change process and security process

This section governs the document itself: how it is versioned, how it changes,
and how a flaw in it is reported and fixed. DMP has one editor, Wyat Soule, and
an open process: anyone may propose a change. Contributions to the repository
are made under its contributor license agreement.

## 14.1 Document versions

DMP versions follow [Semantic Versioning](https://semver.org). The first drafts
are `1.0.0-draft.N`; after 1.0.0, each minor version is preceded by drafts
`1.<minor>.0-draft.N`. A released version, draft or not, is frozen at
`https://dispatch.foo/protocol/<version>/` and never changes there
([§0.2](00-front-matter.md#s0.2)).

- **Major:** a conforming implementation stops conforming, or a valid message
  becomes invalid. Removing or redefining a permanent registry entry, lowering a
  limit, changing a state transition, and changing which error a case returns
  are major. So is adding a kind, an address scheme, or a delivery state a host
  exposes, because a receiver of an earlier version refuses or cannot route what
  it does not know.
- **Minor:** an addition that a receiver of an earlier version tolerates: a ref
  type (received refs of an unknown type are kept, [§4.4](04-messages.md#s4.4)),
  a gate type (an unknown gate fails closed, [§5.6](05-gates.md#s5.6)), an error
  code (an unknown code is handled by its status class,
  [§10.3](10-errors.md#s10.3)), a system marker (an unknown `x-` type is private
  data to an earlier host), an optional field that earlier hosts ignore, a new
  extension version, a new binding section, and making an appendix normative
  (Appendix F).
- **Patch:** editorial changes, errata, and vectors that pin what the text
  already requires. When the text and a vector disagree, the text governs, and
  the patch corrects the vector ([§1.4](01-introduction.md#s1.4)).

## 14.2 Change process

1. A change starts as an issue in the repository, from its "Protocol change"
   form: a summary, the motivation, the sections affected, the type
   (`editorial`, `clarification`, `additive` or `breaking`), the vectors to add,
   change or retire, the impact on implementations, and security notes.
2. One pull request changes the text, the vectors, the reference implementation
   and the registries (regenerating [§11](11-registries.md#s11)) together, and
   adds one entry per change to the "Unreleased" section of the changelog,
   tagged with its type and naming its vector ids. No normative change lands
   without a vector. The editor approves.
3. From 1.0.0, a `clarification`, `additive` or `breaking` change gets a
   `Last call: <date>` comment on its issue and merges no sooner than 14 days
   later. Editorial changes and errata merge at once. Drafts change without
   notice.
4. The next release ships the change: a release freezes the text, the registries
   and the schemas under the version's URL.

## 14.3 Security process

A security flaw in the protocol, its conformance kit or its extension URIs never
starts as a public issue or pull request. It is reported privately, as the
repository's security policy says (`.github/SECURITY.md`), and fixed in a
private fork attached to a GitHub security advisory. The editor tells every
implementation listed in the kit's README about the fix 7 days before the
release, under embargo, then merges the fix and releases it with the advisory.
The 14-day last call of [§14.2](14-versioning.md#s14.2) does not apply.

## 14.4 Extension versions

Each A2A extension URI ([§8](08-a2a-binding.md#s8)) is versioned on its own: a
breaking change to an extension gets a new URI ending `/v2`. Adding a new
extension version is a minor change to DMP; dropping a version is a major one.
The extension URIs under `https://dispatch.foo/a2a/ext/` stay canonical, and any
other URI for them is an alias.

## 14.5 Package versions

The version of the conformance kit's package, `@dispatch-foo/protocol-spec`, is
the version of this document; a release that fixes only the runner is a patch
release, noted "kit only". Implementations version their code on their own. The
reference implementation, `@dispatch-foo/protocol`, reports the DMP version it
implements as `PROTOCOL_VERSION`; it takes the version 1.0.0 once, together with
DMP 1.0.0, and moves independently afterwards. A host's storage format version
is not part of this document.
