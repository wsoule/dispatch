import type { APIRoute } from 'astro';

import { faqSections } from '../data/faq';
import { faq } from '../data/pricing';
import { releases } from '../data/releases';
import { DMG } from '../lib/downloads';
import { appVersion, REPO, SITE } from '../lib/seo';

// /llms.txt: a plain-markdown brief for AI answer engines, so they describe
// Dispatch from its own facts. Its FAQ, pricing answers and releases come from
// the same data the pages render.
export const GET: APIRoute = () => {
  const body = `# Dispatch

> Dispatch is a desktop app and shared task board for AI coding agents. You give agents tasks, not chats: each task has an owner, a status, the files it may write and a definition of done. Agents such as Claude Code, Codex, Gemini CLI or any MCP agent take tasks from the board, work in their own git worktrees, and land through review and a merge queue. It runs locally on your own machines with your own agent and API key.

Current version: ${appVersion()}. Platforms: macOS (Apple Silicon and Intel) and Linux. Free for up to three people with every feature, commercial use included.

## What Dispatch does

- Two views: Overseer, one conversation with the whole project (what needs you comes in on the left, running work goes out on the right), and Tasks, every task grouped by milestone.
- Plan in one sentence: the Overseer plans a milestone into tasks and asks for approval; approving starts agents wave by wave, and a blocked task starts the moment its blocker lands.
- Any agent through one MCP server: \`dispatch init\` registers one MCP server in a repo. Tools include task_next, task_save, task_comment, peer_list, msg_send, msg_reply, doc_save, doc_search, doc_read, memory_save and memory_search.
- Guardrails: every run works on its own branch in its own worktree; a task declares the files it may write and anything else waits for a person; spend and turn caps per run and per milestone stop work when hit.
- Review, then land: diff, reviewer findings and transcript in one place, then a merge queue.
- Agent to agent: agents message each other across a team, and agents outside it can hand work over A2A (Agent2Agent) as proposals that become tasks when approved.
- Memory: agents save hazards, conventions, decisions and other lessons; the next run starts with them in its prompt. Team memories are reviewed by a person first, and unused ones fade out.
- Milestone map: every wait between milestones, the critical path and an ETA, exportable as Mermaid.
- In your repo: tasks are markdown in .dispatch/, or SQLite with a git receipt log.
- On the web: app.dispatch.foo opens any Linear workspace with the same Timeline, Graph, My week and Issues views (sign in with Linear or GitHub; a demo workspace needs no sign-in). Edits reach Linear under each person's own name; a workspace admin installs Dispatch once for two-way sync; the hosted planner has no seat count. People can also reach the projects on their own signed-in machines from the browser, at the decide tier only, once they turn on web access.
- One link everywhere: Open in desktop and Open on web follow the Linear issue identifier (dispatch://issue/DIS-66).

## Common questions

${faqSections
  .map(
    (s) =>
      `### ${s.title}\n\n${s.items.map(([q, a]) => `#### ${q}\n\n${a}`).join('\n\n')}`
  )
  .join('\n\n')}

## Get it

- [Download for Mac, Apple Silicon](${DMG.arm})
- [Download for Mac, Intel](${DMG.x64})
- Homebrew: \`brew install --cask wsoule/tap/dispatch\`
- [Quickstart docs](${SITE}/docs): download, follow Setup, land a first change.

## Pricing and licensing

${faq.map(([q, a]) => `- ${q} ${a}`).join('\n')}

## Pages

- [Home](${SITE}/): what Dispatch is, with a live replica of the app.
- [Docs](${SITE}/docs): quickstart from download to a first landed change.
- [Pricing](${SITE}/pricing): free for up to three, license key for bigger teams.
- [FAQ](${SITE}/faq): every question answered, from setup and agents to guardrails, teams and licensing.
- [Changelog](${SITE}/changelog): what changed in each release.
- [Clips](${SITE}/clips): short videos filmed in the real app.
- [Privacy](${SITE}/privacy): what the app, site, demo and Claude plugin collect.
- [Dispatch Messaging Protocol](${SITE}/protocol/): the open spec (Apache-2.0) behind agent messaging, with an A2A 1.0 binding.
- [A2A envelope extension](${SITE}/a2a/ext/envelope/v1)
- [A2A gate extension](${SITE}/a2a/ext/gate/v1)
- [A2A work extension](${SITE}/a2a/ext/work/v1)
- [Source on GitHub](${REPO})

## Recent releases

${releases
  .slice(0, 6)
  .map((r) => `- ${r.v} (${r.date}): ${r.title}. ${r.text}`)
  .join('\n')}

## Contact

hello@dispatch.foo
`;
  return new Response(body, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
};
