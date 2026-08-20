# Making Dispatch feel like Lovable — without stopping being task-based

Status: direction proposal, not a committed plan. Written 2026-08-20 against
`main` at v0.23.2.

## The question

"Make this more like Lovable, still task-based, and we probably need a web
version." Those are two separable asks, and the second one is much further along
than it looks.

## What Lovable actually does that we don't

Strip the marketing and Lovable is four properties:

1. **One box, zero setup.** You land on a URL, type a sentence, and something
   real exists ~30 seconds later. No install, no `init`, no repo picking.
2. **The running thing is the artifact.** Chat on the left, a live preview of
   the app on the right. You judge the agent by looking at the product, not by
   reading a diff.
3. **Everything has a URL.** Projects are shareable by default, and anyone can
   fork one and keep building.
4. **Ship is one button.** Deploy and a public link are part of the loop, not a
   separate concern.

Dispatch today is the mirror image on every one of these:

1. `brew install --cask` → open app → point at a repo → `dispatch init` → create
   a task → dispatch it.
2. The artifact is a diff, a set of findings, and a PR. There is no way to _look
   at_ what the agent built.
3. Everything is local. A run exists on one machine, in one worktree.
4. Merge is the terminal state. Deploy is out of scope.

Point 2 is the real gap, and it is the one most compatible with staying
task-based. Points 1 and 3 are the web-version ask. Point 4 is out of scope and
should stay out — Dispatch merges into _your_ repo, and your repo already has a
deploy story.

## The thing we should not copy

Lovable's front door is "describe an app." Ours must stay "describe a change to
this repo." Dispatch's whole value is guardrails — declared `writes` paths,
budget and turn caps, verify gates, human-gated scope escalation, findings and
rulings recorded next to the tasks. A prompt box that generates a whole app from
nothing has no repo to be scoped against, so none of that machinery applies.

So: take Lovable's _surface_ (one box, live preview, shareable URL) and keep
Dispatch's _spine_ (a task is a markdown file with declared scope; a run is a
scoped, budgeted agent in an isolated worktree).

## What already exists (the surprising part)

Three things in this repo are much closer to a hosted Dispatch than the roadmap
suggests.

**The desktop UI is already a browser app.** `apps/desktop/src` is ~66k lines of
React across 443 files, and exactly six of them import `@tauri-apps/*`:
`lib/tauri.ts`, `lib/updater.ts`, `lib/notifications.ts`, `App.tsx`,
`hooks/useDataChangedEvents.ts`, and `components/shell/UpdateBanner.tsx`. Every
IPC call in `lib/tauri.ts` already has a documented browser fallback behind
`isTauri()`. The UI talks to `dispatchd` over plain HTTP + WebSocket for
everything that matters; Tauri is used for project registry, native dialogs,
editor/Finder integration, JSONL session observability, and the updater.

**We already host it multi-tenant.** `apps/demo` is a working per-visitor
sandbox host: `SessionManager` seeds a fresh repo in tmpdir, spawns a real
`dispatchd` per visitor, health-checks it, reads its tokens off stdout, and
`proxy.ts` fronts both HTTP and WebSocket behind `/s/<id>/`. It serves _the
desktop Vite bundle_, with config injected into `index.html` as
`__DISPATCH_DEMO__`. Session caps, TTL sweeps, and per-IP rate limiting are all
there. That is the hard 70% of a hosted product, already written and shipped.

**The daemon already has a two-tier auth model.** `api.ts` mints an `agentToken`
(request tier) and an `appToken` (decide tier) at startup, and `requiredTier()`
gates every route. A hosted deployment needs per-user identity on top, but the
authorization _shape_ — who may propose vs. who may decide — is already correct
and is exactly what a shared/observable web session needs.

**`packages/web` is a dead end, on purpose.** It is 945 lines, and the roadmap's
standing decisions say it plainly: "`packages/web` is frozen as a browser
fallback; new UI work happens in `apps/desktop`." Reviving it would mean
rebuilding the board, task detail, runs, review, findings, landing table, and
inbox from scratch against `@dispatch/client`. Do not do that. The web version
is the desktop bundle, hosted.

## The proposal, in dependency order

### A. Live preview — the single biggest Lovable-ness lever

Today a run produces a diff. Give it a running app too.

Every run already executes in an isolated git worktree
(`orchestrator/worktree.ts`). Nothing in `packages/server` currently knows the
words "preview" or "dev server" — this is greenfield. Add a per-run dev-server
supervisor: read a preview command from `.dispatch/config` (default: detect
`dev` in the worktree's `package.json`), start it on an allocated port when the
run reaches a reviewable state, proxy it through `dispatchd` at
`/preview/<runId>/`, and render it in an iframe beside the run's output and
diff. Stop it with the run; sweep it on daemon shutdown the way demo sessions
are swept.

This is the change that makes the product _feel_ like Lovable, and it costs
nothing conceptually — it is a new observation surface over machinery that
already exists. It also improves the desktop app, so it is not web-only work.

Risks worth naming up front: arbitrary child processes with real ports, install
steps for fresh worktrees (a worktree has no `node_modules`), and preview
commands that hang. All three are solvable but none are free.

### B. One box at the front — task-shaped, not app-shaped

`orchestrator/planner.ts` and `plan.ts` already turn a prompt into a task graph,
and `BrainDumpView` already takes freeform text and clusters it into tasks. The
pieces are there; the framing is not. Today you meet a board. You should meet a
box.

Make the empty/first-run state of a project a single prompt field — "what do you
want to change?" — that runs the planner, shows the proposed task graph inline,
and dispatches on confirm. The board stays exactly as it is for everything
after. This is mostly an information-architecture change to `GetStartedView` and
the empty board state, not new backend work.

### C. Hosted Dispatch — promote the demo host to a product

Generalize `apps/demo` from "seeded sandbox with a puppet teammate" to "your
repo, cloned into a container, with a real `dispatchd`":

- Replace `seedSession` with a repo clone (GitHub App install → clone →
  `dispatch init`).
- Replace the in-memory session map with real accounts and persistence.
- Keep the proxy, the caps, the TTL sweeper, the token plumbing, the
  `__DISPATCH_DEMO__` injection seam (rename it `__DISPATCH_HOST__`).
- In the desktop bundle, extend the existing `isTauri()` fallbacks: registry →
  server-side project list, native dialog → repo picker, `openInEditor` /
  `revealInFinder` → hidden, JSONL observability → hidden or server-fed.

The honest cost here is not the frontend. It is that Dispatch's core promise is
"local-first, your machine, your key, nothing uploaded." Hosting inverts that,
and it means owning containers, secrets, per-user API keys or billing, and
someone else's source code at rest. That is a company decision, not a refactor.

### D. Shareable run URLs — cheap Lovable-ness, no hosting required

A run's transcript, diff, findings, and rulings are already structured data. A
`dispatch share <runId>` that publishes a static read-only page gives the "send
someone a link" property that makes Lovable feel viral, without hosting the
product. This is the highest ratio of perceived-Lovable to engineering cost in
the whole list, and it is unblocked today.

## Recommendation

Do **A** first, alone. It is self-contained, it improves the product we already
ship, and it is the difference between "an agent wrote a diff" and "look at the
thing that now works." **B** is a cheap follow-on that reframes the front door
without touching the spine. **D** is a small, independently shippable win.

**C** is real and mostly de-risked by `apps/demo`, but it changes what Dispatch
_is_. Do not start it because the UI happens to be portable — start it when the
local-first promise is deliberately traded away.
