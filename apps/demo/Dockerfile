# Build context is the repo root (this service consumes workspace packages and
# the desktop frontend bundle). Multi-stage: build the UI, ship the runtime.
FROM oven/bun:1-alpine AS build
RUN apk add --no-cache git
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
# Root scripts glob "*", so this already covers apps/desktop's vite bundle
# (apps/desktop/dist) alongside every @dispatch/* package dist/.
RUN bun run build

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
