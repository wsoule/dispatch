import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'conformance-adapter': 'src/conformance/stdio.ts',
  },
  dts: true,
  format: ['esm'],
});
