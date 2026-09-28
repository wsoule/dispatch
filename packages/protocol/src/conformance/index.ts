// The DMP reference adapter, for the conformance kit and for bindings that
// extend it with their own ops (`@dispatch/protocol/conformance`).
export { REFERENCE_HELLO, runVector } from './adapter.js';
export type { AdapterOptions, OpContext, OpHandler } from './adapter.js';
export { UnsupportedOp } from './errors.js';
export { applyWorld, ConformanceHost, worldFrom } from './host.js';
export { serveStdio } from './serve.js';
export type { World } from './host.js';
