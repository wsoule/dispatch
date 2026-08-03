import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/graph.ts', 'src/browser.ts', 'src/carto.ts'],
  dts: true,
  format: ['esm'],
});
