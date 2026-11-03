import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.tsx';

// Self-hosted fonts (bundled via @fontsource, no CDN, no network fetch at runtime): Geist as
// one variable face (every weight the design system uses, 400 to 600) and Geist Mono at the one
// weight it uses, for ids and keys. global.css names the variable face for @dispatch/ui's
// font stack.
import '@fontsource-variable/geist';
import '@fontsource/geist-mono/400.css';
// Stylesheet order is the cascade. @dispatch/ui/styles.css loads first: the design system,
// with Gr8r's tokens on :root, the unlayered page-mode reset and the shared classes. The app's
// own sheets (pierreTheme.css, markdown.css, global.css) load after it, so the few rules they
// keep (the body surface, the markdown prose, Pierre's theme slots) win their overlaps.
import '@dispatch/ui/styles.css';
import './styles/pierreTheme.css';
import './styles/markdown.css';
import './styles/global.css';
import { TeamLocalGate } from './components/shell/TeamLocalGate';
import { ToastProvider } from './components/shell/Toasts';
import { warmBoot } from './lib/bootWarm';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
    },
  },
});

// Before the first render, so the project and the task list are on their way meanwhile.
void warmBoot(queryClient);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        {/* A no-op outside team-local mode; see TeamLocalGate. */}
        <TeamLocalGate>
          <App />
        </TeamLocalGate>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>
);
