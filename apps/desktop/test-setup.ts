// Registers happy-dom's globals so `bun test` can render React; unmounts between
// tests. @testing-library/react is imported dynamically because a static import
// hoists above `register()`, and its `screen` singleton captures `document.body`.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach } from 'bun:test';

GlobalRegistrator.register();

const { cleanup } = await import('@testing-library/react');

afterEach(cleanup);
