import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource/geist-mono/400.css';
import '@dispatch/ui/styles.css';
import '../styles/global.css';
import { MobileApp } from './MobileApp';

// The phone app's entry (m/index.html), served by dispatchd's mobile listener
// at /m/. It shares the desktop app's styles and primitives and nothing else.

// The worker shows pushes and opens the app from a tapped notification; the
// app still works without it (no notifications), so a failure is only logged.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('/m/sw.js', { scope: '/m/' })
    .catch((err: unknown) => {
      console.warn('service worker registration failed', err);
    });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // An unpaired phone gets a 401 every time; retrying only delays the
      // pairing screen.
      retry: (count, error) =>
        count < 2 && !(error instanceof Error && 'status' in error),
    },
  },
});

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <MobileApp />
      </QueryClientProvider>
    </StrictMode>
  );
