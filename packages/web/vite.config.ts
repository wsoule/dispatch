import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Default port dispatchd's `dispatch serve` binds to in dev. The web app is
// served by dispatchd itself in production (see @dispatch/server's static
// handler); this proxy exists only so `bun run dev` can hit a locally running
// daemon without the browser choking on cross-origin fetch/WS calls.
const DEV_DAEMON_URL = 'http://127.0.0.1:4771';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': DEV_DAEMON_URL,
      '/ws': { target: DEV_DAEMON_URL, ws: true },
    },
  },
  build: {
    outDir: 'dist',
  },
});
