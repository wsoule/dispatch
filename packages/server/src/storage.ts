// The project's recorded store backend. The implementation moved to
// `@dispatch/core` (packages/core/src/storage.ts), which is the package all
// three readers of this marker already depend on — the daemon here, the CLI,
// and the MCP server — and which is where the original note in this file said
// it belonged. Re-exported rather than imported at each call site so the
// daemon's existing imports of `./storage.js` keep working.
export { readProjectBackend, writeProjectBackend } from '@dispatch/core';
