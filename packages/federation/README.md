# @dispatch-foo/federation

The federation code every [Dispatch](https://dispatch.foo) daemon and the team
relay share, so they all read a team the same way:

- `verifyLog`: checks a replica's signed operation log (keys pinned on first
  sight, hash chain, signatures) before anything in it is applied;
- `foldRoster`: folds verified roster operations into the team's members, roles,
  hosts and seats, and, once an admin's `content-e2e` op is in, the key epochs
  that end-to-end encrypted team content goes under (the switch, then each
  revoke after it);
- `readLicenseKey`: reads a Dispatch license key. A key that is missing,
  malformed or expired reads as the free tier (`FREE_SEATS` people), never as a
  lockout.

```bash
npm install @dispatch-foo/federation
```

It runs on Node 22.13 or later, and on Bun. The wire types it verifies are
defined in Appendix F of the
[Dispatch Messaging Protocol](https://dispatch.foo/protocol/) and exported from
`@dispatch-foo/protocol/federation`. `vectors/` holds the test vectors for the
log chain and the roster fold, for checking another implementation against this
one.

## What a relay can read

The roster, every machine's public keys, the license, and each op's header:
publisher, time, type, size, and a sealed op's recipients. Mail and state are
always sealed to their recipients. The board, team memory, team docs, presence
and agents travel in the clear until an admin turns on end-to-end encrypted
content; from then on they travel under team keys the relay never holds, with
only presence's kind and an opaque run tag left readable. What was published
before the switch stays readable, a removed member keeps what they already
received, and there is no forward secrecy within one key's epoch.

## License

[Elastic License 2.0](./LICENSE). You may use, copy and modify it, but not offer
it as a hosted service or get around the license key check. See
[LICENSING.md](https://github.com/wsoule/dispatch/blob/main/LICENSING.md).
