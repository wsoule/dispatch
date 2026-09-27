# Reporting Security Issues

Please do not report security vulnerabilities through public GitHub issues.

Use GitHub's private vulnerability reporting: **Security → Report a
vulnerability** on this repository. If that is unavailable, email
<wsoule679@gmail.com> with a description of the issue and steps to reproduce.

You should receive an acknowledgment within a few days. Please allow time for a
fix before public disclosure.

## Scope

Dispatch runs coding agents against local checkouts. Of particular interest:

- Escapes from a run's declared `writes` scope or its git worktree isolation
- The local daemon's HTTP/WS surface being reachable or drivable from outside
  the machine (it is intended to be localhost-only)
- Prompt-injection paths that let repository or task content escalate an agent's
  access beyond what the operator granted
- Flaws in the Dispatch Messaging Protocol (DMP): its text
  (`packages/protocol-spec/spec/`), its conformance kit (the registries,
  schemas, vectors and `dmp-conformance` runner in `packages/protocol-spec`) and
  its three A2A extension URIs, `https://dispatch.foo/a2a/ext/envelope/v1`,
  `https://dispatch.foo/a2a/ext/gate/v1` and
  `https://dispatch.foo/a2a/ext/work/v1`

## Protocol flaws

A flaw in the protocol, its conformance kit or its extension URIs is reported
privately as above, never as a public issue or pull request, because every
implementation of the protocol shares it. It is fixed in the temporary private
fork of a GitHub security advisory. The editor tells every implementation listed
in `packages/protocol-spec/README.md` about the fix 7 days before the release,
under embargo, then merges the fix and releases it with the advisory. The 14-day
last call for protocol changes (see "Protocol changes" in `CONTRIBUTING.md`)
does not apply.
