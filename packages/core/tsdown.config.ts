import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/graph.ts'],
  dts: true,
  format: ['esm'],
});
