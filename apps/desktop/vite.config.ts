import { themeScript } from '@dispatch/ui/lib/theme.ts';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

import { THEME_STORAGE_KEY } from './src/lib/theme.ts';

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

// Applies the stored theme before first paint: a classic inline script, the
// first thing in <body> (before #root), reads 'dispatch:theme' and writes a
// stored 'light' or 'dark' to html[data-theme], else leaves 'system' so
// tokens.css follows the OS live. transformIndexHtml runs for the dev server
// and the build alike, so the daemon-served dist and Tauri get it too. An
// inline script is allowed in both hosts: Tauri's CSP sets only img-src and
// frame-ancestors and leaves script-src unmodified (src-tauri/tauri.conf.json),
// and the daemon's CSP on index.html is frame-ancestors alone (serveIndexHtml
// in packages/server/src/index.ts injects its own inline token script). A
// script-src policy added later would need this script's hash.
const themeBeforePaint: Plugin = {
  name: 'dispatch-theme',
  transformIndexHtml: () => [
    {
      tag: 'script',
      children: themeScript(THEME_STORAGE_KEY, { fallback: 'system' }),
      injectTo: 'body-prepend',
    },
  ],
};

// The app's origin may not be framed. The browser pane frames pages with
// `allow-same-origin`, and a page there can navigate itself onto this origin;
// tauri.conf.json's CSP says the same for the packaged app.
const NO_FRAMING = { 'Content-Security-Policy': "frame-ancestors 'none'" };

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), themeBeforePaint],
  server: { headers: NO_FRAMING },
  preview: { headers: NO_FRAMING },
  resolve: {
    alias: {
      // App modules import from `@/…`; map it to src/.
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
      // Two pages: the desktop app, and the phone app dispatchd's mobile
      // listener serves at /m/ (src/mobile). Separate entries, so the phone
      // never downloads the desktop app.
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        mobile: fileURLToPath(new URL('./m/index.html', import.meta.url)),
      },
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
