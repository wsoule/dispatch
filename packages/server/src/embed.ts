// A narrow, deliberate library surface for embedding a dispatchd instance
// directly in-process — currently only apps/demo's per-session daemon
// (apps/demo/src/daemon.ts), which needs `startServer` itself rather than a
// spawned `dispatchd` process. Kept as its own subpath, re-exporting exactly
// the three names a caller needs to boot and hold onto a server, rather than
// widening the root export (mirrors testing.ts's own reasoning): importing
// this stays an explicit, visible choice, and @dispatch/cli/@dispatch/mcp
// still cannot resolve `@dispatch/server` at all — there is no "." export.
export { startServer } from './index.js';
export type { ServerHandle, StartServerOptions } from './index.js';
