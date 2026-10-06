import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    browser: 'src/browser.ts',
    conformance: 'src/conformance/index.ts',
    'conformance-adapter': 'src/conformance/stdio.ts',
    'federation/index': 'src/federation/index.ts',
  },
  // The ./conformance types name the kit's (Hello, Observation, Step, …); the
  // kit is a devDependency, so its types are inlined, never imported.
  dts: { resolve: ['@dispatch-foo/protocol-spec'] },
  format: ['esm'],
});
