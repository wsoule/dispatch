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
