import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/federation/index.ts'],
  dts: true,
  format: ['esm'],
});
