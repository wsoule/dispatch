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
// Stylesheet order is the cascade: Tailwind first, its preflight and theme in layers, so
// everything unlayered after it wins. @dispatch/ui/styles.css is the design system (Gr8r's
// tokens on :root, the unlayered reset and shared classes): it beats Tailwind's layered base,
// and a name both declared would end up Gr8r's (so tailwind.css declares no `--border` of its
// own). The bridge only adds aliases from the legacy token names the old views still read onto
// Gr8r's; it declares nothing Gr8r does. Tailwind's utilities are imported unlayered (see
// tailwind.css) so a legacy `px-3` still beats Gr8r's `button { padding: 0 }` reset. The
// hand-rolled sheets come last so the few rules they keep (the body surface, the markdown
// prose, Pierre's theme slots) win their overlaps.
import './styles/tailwind.css';
import '@dispatch/ui/styles.css';
import './styles/legacy-bridge.css';
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
