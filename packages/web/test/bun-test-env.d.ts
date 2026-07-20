// The web package's tsconfig sets "types": [] (not ["bun"]) because its
// *browser* code must not see Bun's ambient globals — see the phase-2 plan's
// Slice S3 tsconfig constraint. Test files still run under `bun test` and
// need `bun:test`'s module declaration, which normally comes from that same
// ambient inclusion; this explicit reference (scoped to test/ only, not
// src/) pulls it back in for the program without reintroducing it in browser
// code.
/// <reference types="bun" />
