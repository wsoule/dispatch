# Changelog

Notes for the next release. The release commit carries the summary; this file
holds what a user upgrading needs to know.

## Unreleased

### Changed

- **`dispatch team invite` now makes a team invite link.** It prints one
  `dispatch-team:` link that a teammate pastes into `dispatch team join` (or
  Settings → Team) to join your signed team. The old behaviour, a sign-in token
  for a teammate on a shared daemon, is `dispatch team host invite`; running
  `dispatch team invite` with `--tier`, `--expires` or `--name` still issues
  one, with a note.
- **Team setup is two actions each.** `dispatch team start` founds the team on
  the hosted relay (or `--git`), turning board sync on if it is off; then
  `dispatch team invite <email or handle>`. Teammates run `dispatch team join`.
- **Older team commands moved.** `found`, `trust`, `keys`, `admit`, `dismiss`,
  `close-legacy`, `transport` and the rest are under `dispatch team advanced`,
  and `tokens` and `revoke` under `dispatch team host`. The old names still
  work.
