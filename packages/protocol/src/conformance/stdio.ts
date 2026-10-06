#!/usr/bin/env node
// The reference adapter over stdio, for the kit's runner.
import { REFERENCE_HELLO, runVector } from './adapter.js';
import { serveStdio } from './serve.js';

serveStdio(REFERENCE_HELLO, (vector) => runVector(vector));
