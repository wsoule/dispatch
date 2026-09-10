import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The oldest WebKit this app supports, as a Vite/esbuild target. The Tauri
// webview is the *host's* WebKit rather than a bundled engine, so the oldest
// macOS we let the app install on decides what may reach the bundle. Safari 14
// is macOS 11 (Big Sur); keep this in step with `minimumSystemVersion` in
// tauri.conf.json and the cask's `depends_on :macos` in the release workflow.
const WEBKIT_TARGET = 'safari14';

// Read verbatim and prepended to the build output rather than imported: an
// import only orders itself against other imports, and dependency code that
// calls these APIs runs at module scope. As a banner it is the literal first
// statement of the chunk, which is the only ordering that actually holds.
const polyfills = readFileSync(
  fileURLToPath(new URL('./src/lib/legacyWebkitPolyfills.js', import.meta.url)),
  'utf8'
);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // The component library lives in packages/ui (@dispatch/ui) but keeps its historical
      // `@/ui/…` import path; this must precede the bare `@` alias so it wins the match.
      '@/ui': fileURLToPath(new URL('../../packages/ui/src', import.meta.url)),
      // shadcn/ui components import from `@/…`; map it to src/.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    // Without this, Vite's default baseline tracks whatever is modern at build
    // time and emitted ES2022 class static blocks, which are a *parse* error on
    // WebKit < 16.4 — the whole bundle then never evaluates and the window
    // stays blank rather than failing visibly.
    target: WEBKIT_TARGET,
    rolldownOptions: {
      output: {
        // Entry chunks only: lazily-loaded chunks are reached from an entry
        // that has already installed the shims, so repeating them 300+ times
        // would only add weight.
        banner: (chunk) => (chunk.isEntry ? polyfills : ''),
      },
    },
  },
  // A worker runs in its own global scope, so the main thread's shims do not
  // reach it and it needs the banner applied to its own bundle too.
  worker: {
    rolldownOptions: {
      output: {
        banner: polyfills,
      },
    },
  },
});
