#!/usr/bin/env node
// The A2A reference adapter over stdio, for the kit's runner.
import { serveStdio } from '@dispatch-foo/protocol/conformance';

import { A2A_HELLO, runA2AVector } from './adapter.js';

serveStdio(A2A_HELLO, runA2AVector);
