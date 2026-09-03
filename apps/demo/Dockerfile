# Build context is the repo root (this service consumes workspace packages and
# the desktop frontend bundle). Multi-stage: build the UI, ship the runtime.
#
# The build stage is node, not bun, purely to get pnpm: `oven/bun` images have
# no node and therefore no corepack, and pnpm is a Node program. Nothing in the
# build itself needs bun — tsdown and vite both run under node — and the
# RUNTIME stage is still bun, which is what actually matters, since the demo
# server is a Bun program.
FROM node:24-alpine AS build
RUN apk add --no-cache git
WORKDIR /app
# Keep this pin in step with .prototools and package.json's packageManager.
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
# Only what this image serves, rather than every workspace package: the demo
# server hands out apps/desktop's vite bundle, and reaches @dispatch/core,
# @dispatch/mcp and @dispatch/server through @dispatch/sandbox. The `...`
# suffix means "and everything it depends on". Notably this skips apps/site,
# whose astro build pulls sharp's native musl binaries for a marketing page no
# demo session ever loads.
#
# A wrong filter here is not silent: apps/demo/src/server.ts's bootSelfCheck
# refuses to start when the desktop bundle is missing.
RUN pnpm --filter "@dispatch/sandbox..." --filter "@dispatch/desktop..." run build

FROM oven/bun:1-alpine
# git: seeding + daemons run real git. Identity: daemons commit during runs.
RUN apk add --no-cache git \
 && git config --global user.name "Dispatch Demo" \
 && git config --global user.email "demo@example.com" \
 && git config --global init.defaultBranch main
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun", "run", "apps/demo/src/server.ts"]
