# Dispatch core, phase 6: keys — plan

2026-11-12. Status: **draft for Wyat's review.** Phase 6 of
`docs/specs/2026-11-11-core-and-server-design.md`. Needs phase 5.

## Goal

A project can be shared between devices through a home that cannot read it.
Devices seal what they send, the home only lines it up and stores it, and every
device opens it and applies the same rules.

**Done when** (the spec's check): two devices share a team key through an invite
link; a removed device cannot open later changes.

## Not in this phase

Accounts, billing and the hosted service (phase 7). This phase proves the
encryption against a "blind home": a core in a mode that sequences and stores
bytes and is given no key.

## Decisions this plan makes

1. **One crate, `keys`.** It holds device keys, team keys, the signed device
   list, sealing and opening.
2. **No cryptography is invented.** Only published, reviewed building blocks,
   from maintained libraries: a key exchange, a signature scheme and an
   authenticated cipher. The exact choices are step 1's output.
3. **What stays in the clear** is fixed and small: the team, an opaque project
   id, the sending device, the sequence number and time, the key epoch and the
   size. Everything else is sealed, including which kind of change it is.
4. **The device list is itself a signed chain**: founding, admitting and
   removing a device are each signed by a device already on the list. Every core
   checks the chain; the home cannot add a device.
5. **An invite link carries the key.** Its secret sits in the part of a link
   that is never sent to a server. The team key waits at the home sealed under
   that secret.
6. **Removing a device starts a new epoch.** It never gets the new key.
7. **A security review by someone outside the project** is part of this phase,
   not an afterthought.

## Steps

| #   | Step                  | What it adds                                                                                           | Test that proves it                                                       |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 1   | Design note           | The building blocks chosen, the sealed format, the threat model: what a hostile home can and cannot do | Reviewed and agreed before any code                                       |
| 2   | Device keys           | Each device makes its keys on first use and stores them privately                                      | The private key never appears in logs, the API or the database            |
| 3   | Seal and open         | Seal a change under an epoch's key; open it; refuse anything altered                                   | Published test vectors pass; a flipped bit is refused                     |
| 4   | Blind home            | A home mode that sequences and stores sealed changes and has no key                                    | Searching the home's files for a known task title finds nothing           |
| 5   | Rules on every device | A linked device opens each sequenced change and applies the phase 2 rules itself                       | Two devices and a blind home agree on a claim refusal and a stale edit    |
| 6   | Rules version         | The line records the rules version; an older core reads but does not write                             | An old core is told to update and its writes are refused                  |
| 7   | Device list           | Found a team; admit and remove devices; every core checks the chain                                    | A device the home invents is rejected by every core                       |
| 8   | Invite links          | Make a one-time link; a new device opens the team key with nobody else online                          | The link works once, expires, and the home never holds its secret         |
| 9   | Your own devices      | An existing device of yours approves a new one and seals the key to it                                 | The new device reads the project; an unapproved one cannot                |
| 10  | Removal               | Removing a device starts a new epoch                                                                   | The removed device opens nothing sequenced after its removal              |
| 11  | Sealed snapshots      | A device uploads a sealed snapshot; a new device starts from it                                        | A new device reaches the same state from a snapshot as from the whole log |
| 12  | Recovery              | A recovery phrase per person; what happens when every device is lost                                   | The phrase restores access; without it, nothing does                      |
| 13  | Outside review        | A written review of the design and the code by someone who was not on the build                        | Its findings are fixed or answered in writing                             |

## Notes for whoever builds it

- **The design exists.** Team content keys, epochs and sealing were built for
  federation: `packages/protocol/src/federation/content.ts`, `hpke.ts`,
  `seal.ts`, `keys.ts`; `packages/server/src/team/federation/content.ts`,
  `teamKeys.ts`, `roster.ts`; and the test vectors in
  `packages/federation/vectors`.
  `docs/specs/2026-10-05-sealed-relay-contract.md` says what a relay could see.
  Read them for the design and the mistakes already found; write fresh Rust.
- **Liveness is the home's own fact.** "This device stopped answering" is
  written into the line in the clear by the home, with its time. Cores turn it
  into stalled sessions and released claims. The home's clock is the only clock
  the rules use.
- **Step 5 is why phase 2's rules had to be pure.** If two devices can disagree,
  this is where it shows.
- **A removed person keeps what they had.** Say so in the product; do not
  pretend a key change takes it back.

## What I have not verified

- Which Rust libraries to use. Step 1 chooses them and says why.
- That an invite link carrying the key is acceptable to you as a risk: anyone
  who reads the link before it is used can join. The alternative needs an
  existing member online to admit each new device.
- How run logs, which are large and streamed, are best sealed: per entry or in
  chunks.
