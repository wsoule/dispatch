# @dispatch/web

The hosted Dispatch service at <https://app.dispatch.foo>: GitHub or Linear
sign-in (linked into one account), teams and invites, device sign-in for
machines, the team hub that machines' agents message each other through, and the
hosted MCP endpoint (with OAuth) for claude.ai. Elastic-2.0, the team tier
(`LICENSE`).

It moved here from `wsoule/dispatch-relay` branch `team-hub` (`app/`, at
c8267f8). The relay itself stays in that repo.

## Run it locally

```bash
moonx web:dev --ignore-ci-checks
```

That serves <http://localhost:8787> with `DEV_LOGIN=1`, so you can sign in
without GitHub. Data goes to `apps/web/data/` (gitignored).

```bash
moonx web:test
```

`test/mesh.test.ts` starts real machine hubs from `packages/mcp/dist`, which
`^:build` builds first.

## The hosted planner

`/w/<key>/` serves the desktop's own bundle with its daemon pointed at
`/w/<key>`, and `/w/<key>/api/*` answers as a read-only dispatchd built from a
Linear workspace (`src/planner/`). `/w/demo/` is Better Tracker's showcase
workspace, open to anyone. "Open a Linear workspace" on the home page keeps a
read grant (sealed with `TEAM_SECRET`) and opens `/w/<urlKey>/`; only people
with a grant see that workspace, each through their own grant. Granting needs
both `TEAM_SECRET` and `LINEAR_CLIENT_ID`.

## Configuration

| Variable                                    | Meaning                                                                                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                      | Listen port. Railway injects `8080`; leave the domain's target port unset.                                                                                |
| `HOSTNAME_BIND`                             | Bind address, default `0.0.0.0`.                                                                                                                          |
| `DATA_DIR`                                  | SQLite (`team.db`) and per-team hub stores (`hubs/`). `/data` in the image.                                                                               |
| `PUBLIC_URL`                                | The origin links and OAuth redirects use: `https://app.dispatch.foo`.                                                                                     |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | The GitHub OAuth app "Dispatch". Without them, GitHub sign-in answers 503.                                                                                |
| `LINEAR_CLIENT_ID`                          | The public Linear OAuth app "Dispatch" (PKCE, no secret). Its redirect URIs must include `<PUBLIC_URL>/auth/linear/callback`. Unset hides Linear sign-in. |
| `TEAM_SECRET`                               | Seals teams' Linear keys at rest. Changing it orphans every stored key.                                                                                   |
| `RESEND_API_KEY`                            | A Resend API key: admins invite by email. Unset, invites are links to copy.                                                                               |
| `INVITE_EMAIL_FROM`                         | The invite sender, on a domain verified in Resend: `Dispatch <invites@dispatch.foo>`.                                                                     |
| `DESKTOP_DIST_DIR`                          | The desktop bundle the hosted planner serves. Defaults to `apps/desktop/dist`, which the image builds.                                                    |
| `DEV_LOGIN`                                 | `1` allows the dev sign-in. Ignored when `PUBLIC_URL` is `https://`.                                                                                      |

## Deploy

Railway service `dispatch-team` in project `dispatch`, with the volume
`dispatch-team-volume` at `/data`. The service is still declared in
dispatch-relay's `.railway/railway.ts` (partial `relay`), not this repo's. The
image builds from the repo root with `apps/web/Dockerfile`. The entrypoint hands
a root-owned volume to the `bun` user and drops root.

The build and deploy settings live on the service itself (set 2026-11-06):
Dockerfile builder with `apps/web/Dockerfile`, healthcheck `/healthz` with a
30-second timeout, and restart on failure up to 10 times. Railway no longer lets
a service without one opt in to a `railway.json`, and the repo root has none, so
without these settings `railway up` falls back to Railpack and fails with "No
start command detected". Restart policy is accepted but does not read back
through the API or IaC.

Deploy from an export of the commit to ship, outside any checkout. The Railway
CLI uploads the folder its link resolves to, and in a worktree under the main
checkout's `.claude/worktrees/` that is the main checkout itself. The main
checkout's `.gitignore` also skips `.claude/*`, so the worktree's files never
reach the upload:

```bash
git archive <commit> | tar -x -C /tmp/team-deploy
cd /tmp/team-deploy
railway up --project 25cb87e4-83ce-4feb-afcf-8fb36c6f4f7e --environment production --service dispatch-team --detach
```

Check `https://app.dispatch.foo/healthz` afterwards. Moving the service's
declaration from the relay partial into this repo's `.railway/railway.ts` (with
a `/healthz` healthcheck) is a follow-up that touches both repos.
