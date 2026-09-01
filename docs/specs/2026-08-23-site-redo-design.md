# Site redo: opencode-style flow, app-native look — design

2026-08-23. Approved in brainstorming with Wyat. Scope: `apps/site` only.
Replaces the 2026-08-10 site-copy-refresh page wholesale.

## What we're doing and why

Full redo of the marketing site. The reference is <https://opencode.ai/> —
specifically its **page flow and copy tone**, not its visual skin. Wyat: "i
don't want mono or hard lines, I just like the flow of the page and the copy."
So: terse hero, install command immediately, a plain what-it-is list, proof,
FAQ, zero marketing fluff. Confident and short.

Decisions made:

- **Full redo.** New structure and new copy. Positioning stays "Linear, for
  agents."
- **Primary CTA: install.** A copyable brew command in the hero.
- **Product proof: real app screenshots + the live demo iframe.** No drawn board
  art carried forward as the hero.
- **Visuals match the desktop app.** The site uses the app's design tokens,
  status colors, and density. Light and dark. The site looks like the product it
  sells.
- **The open-source story is built in.** Open-core was decided 2026-08-23 (MIT
  core/cli/mcp, FSL app, private server; epic `e-c25f9c`). The page is designed
  assuming a public repo and ships with or after publication, so it never lies.

## Stack

`apps/site` becomes a small **Astro** project, static output. Rationale:
docs/changelog/pricing pages become siblings under `src/pages/` after the OSS
launch, and sections live as small components instead of one 1,100-line HTML
file.

- `bun.lock` workspace member like the other apps; Astro via the root
  `workspaces.catalog`.
- **Token sync**: a build step copies `apps/desktop/src/styles/tokens.css` into
  the site before `astro build`. One source of truth. The tokens already handle
  dark via `@media (prefers-color-scheme: dark)`, so the site gets both themes
  for free. No new palette, no new hex values.
- **Serving**: keep `server.ts` + Dockerfile + `railway.json`; the server points
  at Astro's `dist/` instead of `public/`. Deploy stays `railway up` from
  `apps/site` (service `dispatch-site`, Railway injects PORT).
- The current `public/shots/` screenshots carry over until re-shot.
- Respect `prefers-reduced-motion` for anything that moves.

## Voice rules (unchanged from the 2026-08-10 spec)

- Short and sweet. Fragments over compound sentences.
- No em-dashes anywhere on the page.
- Opinionated and a little playful.
- No implementation detail leaking into product voice.

## Page flow

1. **Nav** — wordmark, GitHub, Download button. One thin line.
2. **Hero** — h1 + two-line lede + copyable install command. Quieter siblings:
   Download the app, Try the live demo ↓.
3. **Big real screenshot** — the board view, immediately under the hero. The
   page shows the product before it says anything else.
4. **What it is** — terse list, one line per item.
5. **Why a board** — the chat-vs-board argument, compressed from the old site's
   set piece to a few lines plus one visual.
6. **Live demo** — auto-starting iframe (external service, unchanged), Open full
   screen ↗.
7. **Open source** — the open-core story plus the built-with-itself receipt.
8. **FAQ** — accordion, four questions.
9. **Footer** — install command once more, links.

## Copy skeleton (draft for Wyat's review, not yet approved verbatim)

**Title:** `Dispatch: Linear, for agents` **Meta description:**
`Linear, for agents. A board, reviews, and a merge queue, all markdown in your repo.`

**Hero h1:** `*Linear*, for agents.` (italic Linear kept) **Hero lede:**
`Chatting is overrated. Every session on one board: what it's doing, what blocks it, what's next.`
**Install:** `brew install --cask wsoule/tap/dispatch` with a copy button.
**Secondary links:** `Download the app` · `Try the live demo ↓`

**Screenshot caption:** `The board. Every agent, every task, right now.`

**What it is** (h2: `What you get.`):

- A board. Every task, every session, one screen.
- Dispatch from the board. Pick a task, pick an agent, go.
- Blocked means blocked. Blocked tasks don't dispatch.
- Reviews built in. Diffs, findings, request changes.
- A merge queue. Green lands. You don't babysit.
- Markdown in your repo. The backlog lives in `.dispatch/`.
- Two-way Linear sync. Your tracker stays current.
- Warden. One chat to steer every session. It asks first.

**Why a board** (h2: `Everything else is a chat window.`):
`Same agent, same work. A transcript makes you scroll back and rebuild it in your head. A board just shows you.`
One visual: a screenshot pair or a compact adaptation of the old vs-section
board.

**Live demo** (h2: `See for yourself.`):
`A real board, running in your browser. Nothing ever goes wrong with live demos, right?`
Keep `Open full screen ↗`.

**Open source** (h2: `Open core.`):
`The engine is MIT. The app is source available. Read it, run it, extend it.`
Receipt line:
`Built with itself. This repo's backlog is in .dispatch/, and commits tagged (run r-…) were written by its agents.`
GitHub link.

**FAQ** (h2: `Questions.`):

- _Does it replace Linear?_ It can. Or sync with it. Dispatch is where agents
  work; your tracker stays current either way.
- _What agents does it run?_ Claude Code today. More harnesses are coming.
- _Where does my code go?_ Nowhere. Local by default. Opt into team sharing when
  you want it.
- _What does it cost?_ Free to run locally. Bring your own agent.

**Footer:** install command, GitHub, the built-with-itself line.

## Assets to produce

Real app screenshots in light and dark: board (hero), review view, Warden.
Produced with the browser-dev harness (`?root=&port=`) against the mock project
generator; Wyat eyeballs and picks. Never ship a screenshot of a real client
repo.

## Out of scope

- Docs, changelog, and pricing pages (the Astro structure just leaves room).
- Desktop-app copy.
- Any change to the demo service.

## Verification and ship

- `bun run format` + `bun run lint` from root, plus the site's own build.
- Eyeball the page served locally, light and dark; show Wyat before deploy.
- Announce before starting work on `apps/site` (concurrent sessions may be on
  the same surface).
- Ship with or after the `e-c25f9c` source publication so the open-source
  section is true on day one. If the site must go out earlier, the open source
  section is the only part held back.
- Deploy: `railway up` from `apps/site`.
