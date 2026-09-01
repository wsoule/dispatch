# The image ships a prebuilt dist: `bun run deploy` builds locally, where
# workspace deps (@dispatch/tokens) and bun.lock govern, then uploads it.
# No install or build inside the image; .railwayignore re-includes dist/.
FROM oven/bun:1-alpine

WORKDIR /app
COPY server.ts ./
COPY dist ./dist

EXPOSE 3000
CMD ["bun", "run", "server.ts"]
