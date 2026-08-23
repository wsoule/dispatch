# Two stages: build the Astro site, then ship only Bun + server.ts + dist.
# Versions are pinned directly in package.json (not catalog:) because this
# image builds apps/site standalone, outside the workspace.
FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY package.json ./
RUN bun install
COPY astro.config.mjs ./
COPY src ./src
COPY public ./public
RUN bun run build

FROM oven/bun:1-alpine
WORKDIR /app
COPY server.ts ./
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["bun", "run", "server.ts"]
