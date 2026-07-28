# The site is a static server plus one HTML file, so the image is the Bun runtime and the source.
# A Dockerfile rather than builder autodetection: Railway has moved from Nixpacks to Railpack, and
# a nixpacks.toml here was silently ignored on the second deploy. This says what runs, and keeps
# saying it.
FROM oven/bun:1-alpine

WORKDIR /app
COPY server.ts ./
COPY public ./public

# No install step because there are no dependencies — the point of serving this with Bun's own
# file handling was to avoid dragging the workspace's toolchain into an image that serves HTML.

EXPOSE 3000
CMD ["bun", "run", "server.ts"]
