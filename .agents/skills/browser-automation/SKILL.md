---
name: browser-automation
description:
  Use when opening, inspecting, clicking, filling, snapshotting, or otherwise
  automating web pages for this repo, including local dev servers and
  browser-based verification.
---

# Browser Automation

The browser tooling this repo ships is Playwright, behind the desktop app's e2e
suite (`moonx desktop:e2e`; `testing-and-verification` covers when a browser
test is warranted). For ad-hoc inspection of a running page, use the browser
tooling your harness provides. `agent-browser` also works when it is installed,
but it is not a dependency of this repo.

Use browser automation for behavior that needs a rendered page, real DOM state,
or interactive verification. Prefer focused Bun tests for pure logic and
non-browser integration behavior.
