import { renderToString } from 'react-dom/server';

import {
  AlertStrip,
  AppShell,
  CommandPaletteProvider,
  Kbd,
  PropertyList,
  SignedOutFrame,
  SkeletonRows,
  SlideOver,
  ToastProvider,
} from '../src/index';

// Run by shell-ssr.test.tsx in a child `bun run`, which has no happy-dom
// preload: there is no window or document here, exactly like a Next server
// render. Every shell component must render without touching either.

function render(): string {
  return renderToString(
    <ToastProvider>
      <CommandPaletteProvider
        items={[
          {
            id: 'week',
            label: 'Go to My week',
            section: 'Navigation',
            href: '/week',
            shortcut: ['G', 'W'],
          },
        ]}
      >
        <AppShell
          appName="Milestone Planner"
          workspaceName="Northwind"
          brandHref="/week"
          nav={[
            {
              id: 'week',
              label: 'My week',
              href: '/week',
              icon: null,
              count: 4,
              current: true,
            },
          ]}
          sections={[
            {
              id: 'projects',
              title: 'Projects',
              action: { label: 'All', href: '/projects' },
              items: [
                {
                  id: 'atlas',
                  label: 'Atlas migration',
                  href: '/timeline?project=atlas',
                  status: 'overdue',
                  statusLabel: 'Overdue',
                },
              ],
            },
          ]}
          settings={{ href: '/settings' }}
          user={{ name: 'Pat Lee', badge: 'DEMO' }}
          signOut={{ action: '/api/auth/logout', method: 'post' }}
          themeStorageKey="theme"
          storageKey="sidebar"
          crumbs={[{ label: 'Timeline', href: '/timeline' }, { label: 'M3' }]}
          tabs={[{ id: 'week', label: 'My week', href: '/week', icon: null }]}
        >
          {/* Linkable drawers (?milestone=<id>) render open on the server. */}
          <SlideOver open onClose={() => undefined} title="M3 Cutover">
            <AlertStrip label="Overdue" tone="danger">
              Overdue by 3 days.
            </AlertStrip>
            <PropertyList items={[{ label: 'Due date', value: 'Oct 18' }]} />
            <SkeletonRows rows={2} />
            <Kbd>Esc</Kbd>
          </SlideOver>
        </AppShell>
      </CommandPaletteProvider>
    </ToastProvider>
  );
}

// The brand row as the workspace switcher: a PickerPopover trigger, so the
// picker's media queries and save state must render on the server too.
const switcher = renderToString(
  <ToastProvider>
    <AppShell
      appName="Milestone Planner"
      workspaceName="Northwind"
      brandHref="/week"
      workspaceSwitcher={{
        workspaces: [
          { id: 'org-northwind', name: 'Northwind', current: true },
          { id: 'org-globex', name: 'Globex', hint: 'Guest' },
        ],
        onSwitch: () => undefined,
        connect: { label: 'Connect another workspace', href: '/setup/connect' },
      }}
      nav={[{ id: 'week', label: 'My week', href: '/week', icon: null }]}
    />
  </ToastProvider>
);

const signedOut = renderToString(
  <SignedOutFrame
    appName="Milestone Planner"
    brandHref="/"
    label="Sign in"
    footerLinks={[
      { label: 'Privacy', href: '/privacy' },
      { label: 'Terms', href: '/terms' },
      { label: 'Contact', href: '/contact' },
    ]}
  >
    <p>Sign in</p>
  </SignedOutFrame>
);

console.log(
  JSON.stringify({
    hasWindow: typeof window !== 'undefined',
    hasDocument: typeof document !== 'undefined',
    shell: render(),
    switcher,
    signedOut,
  })
);
