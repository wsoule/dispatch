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
| `DEV_LOGIN`                                 | `1` allows the dev sign-in. Ignored when `PUBLIC_URL` is `https://`.                                                                                      |

## Deploy

Railway service `dispatch-team` in project `dispatch`, with the volume
`dispatch-team-volume` at `/data`. The service is still declared in
dispatch-relay's `.railway/railway.ts` (partial `relay`), not this repo's. The
image builds from the repo root with `apps/web/Dockerfile`. The entrypoint hands
a root-owned volume to the `bun` user and drops root.

Once, before the first deploy from this repo, set the service's config-as-code
path (Settings → Config-as-code) to `apps/web/railway.json`. That file carries
the Dockerfile path, the `/healthz` deploy gate and the restart policy, which
the relay's own `railway.json` used to carry. Neither the IaC partial nor the
image's `HEALTHCHECK` sets them: Railway ignores the latter, and restart policy
does not round-trip through IaC. Railway deprecates `railway.json` after
2026-12-01, so move these settings into IaC before then.

Then, from a clean checkout of the commit to ship, at the repo root:

```bash
railway up --service dispatch-team --detach
```

Check `https://app.dispatch.foo/healthz` afterwards. Moving the service's
declaration from the relay partial into this repo's `.railway/railway.ts` (with
a `/healthz` healthcheck) is a follow-up that touches both repos.
