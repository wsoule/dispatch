// This package's tsconfig sets "types": [] (not ["bun"]) because its
// *browser* code (api.ts's fetch/WebSocket/window usage, useTasks.ts's React
// hooks) must not see Bun's ambient globals — same constraint @dispatch/web
// documents in its own copy of this file. Test files still run under
// `bun test` and need `bun:test`'s module declaration, which normally comes
// from that same ambient inclusion; this explicit reference (scoped to
// test/ only, not src/) pulls it back in for the program without
// reintroducing it in browser code.
/// <reference types="bun" />
