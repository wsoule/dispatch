import { renderToString } from 'react-dom/server';

import {
  AlertStrip,
  AppShell,
  CommandPalette,
  CommandPaletteProvider,
  ConfirmDialog,
  Dialog,
  Kbd,
  PropertyList,
  SignedOutFrame,
  SkeletonRows,
  SlideOver,
  Spinner,
  ToastProvider,
  Tooltip,
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

// A desktop host's switcher (Dispatch's projects): its own words and a
// connect row that opens the host's dialog in place, a function the
// server never calls.
const projectSwitcher = renderToString(
  <AppShell
    appName="Dispatch"
    brandHref="#/"
    workspaceSwitcher={{
      workspaces: [{ id: 'dispatch', name: 'dispatch', current: true }],
      onSwitch: () => undefined,
      connect: { label: 'Add project…', onSelect: () => undefined },
      label: 'Switch project',
      menuLabel: 'Project',
      groupLabel: 'Projects',
      onOpenChange: () => undefined,
    }}
    chromeAttributes={{ 'data-tauri-drag-region': '' }}
    nav={[{ id: 'issues', label: 'Issues', href: '#/issues', icon: null }]}
  />
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

// A desktop host's gate screen: the header row is the window's drag
// region.
const gate = renderToString(
  <SignedOutFrame
    appName="Dispatch"
    brandHref="#/"
    label="Setup"
    mainId="gate-main"
    chromeAttributes={{ 'data-tauri-drag-region': '' }}
    actions={<button type="button">Sign out</button>}
  >
    <h1>Set up Dispatch</h1>
  </SignedOutFrame>
);

// The overlays open on the server (a linkable dialog, a persistent hint):
// the layer stack, focus, the scroll lock and placement wait for the
// client.
const overlays = renderToString(
  <>
    <Dialog
      open
      onClose={() => undefined}
      title="Publish"
      description="Share this doc with the team."
      actions={<button type="button">Publish</button>}
      data-slot="dialog-content"
    >
      <input aria-label="Title" />
    </Dialog>
    <ConfirmDialog
      open
      title="Delete this view?"
      confirmLabel="Delete view"
      tone="danger"
      onConfirm={() => undefined}
      onCancel={() => undefined}
    >
      Its filters are lost.
    </ConfirmDialog>
    <Tooltip content="Visible to the team" defaultOpen>
      <button type="button">Visibility</button>
    </Tooltip>
    <Tooltip content="Never shown on the server">
      <button type="button">Quiet</button>
    </Tooltip>
    <Spinner label="Starting the daemon" />
  </>
);

// A modal form drawer (the task composer) open on the server: the scrim,
// aria-modal and the footer row are markup; the layer stack, the scroll
// lock and focus wait for the client.
const modalDrawer = renderToString(
  <SlideOver
    open
    modal
    size="wide"
    onClose={() => undefined}
    title="New task"
    data-testid="task-composer"
    footer={<button type="button">Create task</button>}
  >
    <input aria-label="Task title" />
  </SlideOver>
);

// The palette mounted open as a file finder: its own names, and a host
// match drawn at the host's indices on a mono path. Focus, the scroll lock and the phone
// query wait for the client.
const quickOpen = renderToString(
  <CommandPalette
    items={[
      {
        id: 'src/app.ts',
        label: 'src/app.ts',
        section: 'Files',
        matched: true,
        highlight: [0, 4],
        mono: true,
      },
    ]}
    onClose={() => undefined}
    onRun={() => undefined}
    label="Go to file"
    inputLabel="Go to file"
  />
);

console.log(
  JSON.stringify({
    hasWindow: typeof window !== 'undefined',
    hasDocument: typeof document !== 'undefined',
    shell: render(),
    switcher,
    projectSwitcher,
    signedOut,
    gate,
    overlays,
    modalDrawer,
    quickOpen,
  })
);
