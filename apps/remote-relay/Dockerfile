# The remote access relay (docs/specs/2026-11-06-remote-access-design.md).
# Nothing deploys this yet: it is not in .railway/railway.ts. The intended home is a Railway
# service at remote.dispatch.foo, which fronts it with TLS and injects PORT.
#
# The build context is the repo root, because the relay depends on the
# workspace package @dispatch/remote, which is built to dist/ first.
FROM node:24-slim AS build
WORKDIR /app
# Keep this pin in step with .prototools and package.json's packageManager.
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY . .
# The relay and the one package it runs on. Not "...": that would pull the
# daemon in through the relay's test-only devDependencies.
RUN pnpm install --frozen-lockfile \
  --filter @dispatch/remote --filter @dispatch/remote-relay
RUN pnpm --filter @dispatch/remote run build

FROM oven/bun:1-alpine
# The workspace as built, so @dispatch/remote resolves to its dist/ through
# the same node_modules links pnpm made.
COPY --from=build /app /app
WORKDIR /app/apps/remote-relay
# Relay state is all in memory: a restart drops every session and both
# sides reconnect on their own.
ENV RELAY_TRUST_PROXY=1
EXPOSE 8080
USER bun
CMD ["bun", "run", "src/main.ts"]
