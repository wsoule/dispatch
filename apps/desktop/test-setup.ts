// Registers happy-dom's DOM globals so `bun test` can render React components,
// and unmounts anything a test rendered so trees don't leak between tests.
//
// @testing-library/react must be imported dynamically, after registration:
// ES module imports are hoisted and evaluated before this file's own
// top-level code runs, so a static import would load @testing-library/dom's
// `screen` singleton (which snapshots `document.body` at import time) before
// GlobalRegistrator.register() has defined `document`.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach } from 'bun:test';

GlobalRegistrator.register();

const { cleanup } = await import('@testing-library/react');

afterEach(cleanup);
