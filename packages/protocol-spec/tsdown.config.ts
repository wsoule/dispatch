import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/index.ts', bin: 'src/bin.ts' },
  dts: true,
  format: ['esm'],
});
