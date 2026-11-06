# The hosted Dispatch service (app.dispatch.foo). Build context is the repo
# root: the service imports @dispatch-foo/core and @dispatch-foo/protocol from
# the workspace, built from source here.
#
# The build stage is node only to get pnpm through corepack; the runtime is
# bun, which is what the service is.
FROM node:24-alpine AS build
RUN apk add --no-cache git
WORKDIR /app
# Keep this pin in step with .prototools and package.json's packageManager.
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY . .
# Only the service and what it imports at runtime: `--filter-prod` follows
# dependencies, not devDependencies (the tests' @dispatch-foo/mcp would pull in
# the whole daemon). --ignore-scripts skips the root `prepare` (moon's git hooks:
# no .git and no moon here) and astro's native postinstalls, which this
# service never loads.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter-prod "@dispatch/web..."
RUN pnpm --filter-prod "@dispatch/web^..." run build

# Debian slim, not alpine: the entrypoint drops root with util-linux's setpriv.
FROM oven/bun:1.4.2-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
COPY --from=build /app /app
COPY apps/web/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /data && chown bun:bun /data
# Railway bans VOLUME in Dockerfiles; the volume is attached to the service at
# /data. The entrypoint hands it to the `bun` user and drops root.
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT ?? 8080) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "apps/web/src/main.ts"]
