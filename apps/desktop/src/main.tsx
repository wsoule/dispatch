import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.tsx';

// Self-hosted fonts (bundled via @fontsource — no CDN, no network fetch at runtime). Inter
// ships as one variable face so the 450 body weight exists; mono is the single weight the
// CSS references.
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
// Tailwind + shadcn theme first, so the hand-rolled token/global styles that follow win any
// overlap during the migration to shadcn primitives.
import './styles/tailwind.css';
import '@dispatch/tokens/tokens.css';
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
