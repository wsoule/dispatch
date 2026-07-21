import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted fonts (bundled via @fontsource — no CDN, no network fetch at runtime).
// Only the weights actually referenced in this codebase's CSS are imported.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/600.css';
// Tailwind + shadcn theme first, so the hand-rolled token/global styles that follow win any
// overlap during the migration to shadcn primitives.
import './styles/tailwind.css';
import './styles/tokens.css';
import './styles/pierreTheme.css';
import './styles/global.css';
import App from './App.tsx';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
    },
  },
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>
);
