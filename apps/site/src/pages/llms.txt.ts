import type { APIRoute } from 'astro';

import { faqSections } from '../data/faq';
import { releases } from '../data/releases';
import { DMG, INSTALL, TEAM_SERVER, VERSION } from '../lib/downloads';
import { REPO, SITE } from '../lib/seo';

// /llms.txt: a plain-markdown brief for AI answer engines, so they describe
// Dispatch from its own facts. Its FAQ and releases come from the same data the
// pages render.
export const GET: APIRoute = () => {
  const body = `# Dispatch

> Dispatch keeps a board, docs and an Overseer for coding agents on a Mac, used from the agent you already have over MCP or from the native Dispatch app. In the app each person talks to their own Overseer, which plans the work, creates tasks, sends Claude Code or Codex to do them on that person's machine, and flags the person down only when a task needs their input. Finished work lands as a GitHub pull request.

There are two ways to use it, on the same core and from the same installer: (1) keep the agent you already use (Claude Desktop, Cursor, Claude Code, OpenCode, Codex, T3 Code or any MCP client) and add the Dispatch core as a stdio MCP server, \`{"command": "/Users/YOU/.local/bin/dispatch-core", "args": ["mcp"]}\`, so it can read the board and tasks, comment, see runs and diffs, message the Overseer and teammates, ask the person for approvals, and use docs, shared memory and Linear ([setup per client](${SITE}/docs#connect)); or (2) use the Dispatch app, a native Mac app with the Overseer, board, planning views and the Hub.

Current version: ${VERSION}. Platform: macOS (one universal build for Apple silicon and Intel). Solo use is free; Team is $10 per seat per month.

## What Dispatch does

- The Overseer: you say what you want; it plans tasks on a board and sends agents to them.
- Agents run as their own CLIs: Claude Code and Codex, on your machine, with your own sign-in or API key.
- Needs you: the Overseer interrupts only for an agent's question, a tool approval, failed checks or a pull request ready to merge.
- Declared files only warn other Overseers about likely merge conflicts. Nothing is denied for cost or declared files.
- Landing: the project's own checks run, a pull request opens on GitHub with a description, GitHub merges it, and review comments on it go back to the agent. A reviewer agent is optional and never blocks. There is no merge queue.
- The app: native (GPUI). Every panel is a small JavaScript mod and every theme is a file, so a person or their agent can change any panel. Views: Overseer and Needs you, board, sessions, run view, task page, terminal, Going out, and planning (My week, Allocation, Projects, Timeline, Graph). Light and dark.
- Teams: a hosted team server at ${TEAM_SERVER}. Teammates share projects, boards sync, you see teammates' agents, and one core is named lead per project. The server stores only sealed (end-to-end encrypted) bytes and cannot read task titles or code. Sign in with Linear; GitHub sign-in is coming.
- Two-way Linear sync: sign in to Linear from Settings (OAuth in the browser, no API key), connect each project to a Linear team, and import its existing issues, projects and milestones.
- The core: one background process per Mac (\`dispatch-core\`) that holds projects, boards, agent runs, terminals and syncs. The app is a view onto it; closing the window stops nothing. Every app action is a core command (\`dispatch-core help\` lists about 200), and \`dispatch-core mcp\` serves it over MCP to agents. It ships inside the app; the installer links \`dispatch-core\` into ~/.local/bin.

## Install

- Terminal (macOS): \`${INSTALL}\`
- [Download the DMG](${DMG})
- [Getting started](${SITE}/docs)

## Pricing and licensing

- Solo: free. Your machine, your agents, every local feature.
- Team: $10 per seat per month on the hosted team server, billed through Stripe. No free seats.
- The core (daemon, CLI, protocol) is Apache-2.0. The desktop app is FSL-1.1-ALv2 and becomes Apache-2.0 two years after each release. The team server is under the Elastic License 2.0.

## Common questions

${faqSections
  .map(
    (s) =>
      `### ${s.title}\n\n${s.items.map(([q, a]) => `#### ${q}\n\n${a}`).join('\n\n')}`
  )
  .join('\n\n')}

## Pages

- [Home](${SITE}/): what Dispatch is, with screenshots of the app.
- [Download](${SITE}/download): the install line and the DMG.
- [Docs](${SITE}/docs): getting started, connecting your own agent over MCP, and setting up a team.
- [Hub](${SITE}/hub): panels, themes and layouts for the app, listed at ${SITE}/hub/index.json; an agent can install one with \`dispatch-app hub list\`, \`dispatch-app hub show <id>\` (read the code first), \`dispatch-app hub install <id>\` and \`dispatch-app hub remove <id>\`.
- [Pricing](${SITE}/pricing): Solo and Team.
- [FAQ](${SITE}/faq): every question answered.
- [Changelog](${SITE}/changelog): what changed in each release.
- [Privacy](${SITE}/privacy): what this website collects.
- [Team server privacy](${TEAM_SERVER}/privacy) and [terms](${TEAM_SERVER}/terms)
- [Source on GitHub](${REPO})

## Releases

${releases.map((r) => `- ${r.v}: ${r.title}. ${r.points.join(' ')}`).join('\n')}

## Contact

hello@dispatch.foo
`;
  return new Response(body, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
};
