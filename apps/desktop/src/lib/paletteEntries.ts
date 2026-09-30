// The command menu's rows, built as plain data so the sections and their shortcut hints are
// testable without React. `CommandPalette` accepts these structurally (it needs `id`,
// `label`, `sublabel?`, `kind`, `run`); the extra `section`/`icon`/`shortcut` fields are for
// the grouped Linear-style menu that replaces the flat list.

import type { DocHit } from '@dispatch/client';
import type { ReactNode } from 'react';

import type { GlobalView, ProjectView } from './appNav';
import type { PaletteItem } from './paletteMatch';

export type PaletteSection =
  | 'tasks'
  | 'docs'
  | 'navigation'
  | 'actions'
  | 'inbox'
  | 'views';

export interface PaletteEntry extends PaletteItem {
  /** A short tag shown at the entry's right edge — "task", "go to", "action". */
  kind: string;
  section: PaletteSection;
  icon?: ReactNode;
  /** The keycap hint, as it is printed: `⌘1`, `C`, `G A`. */
  shortcut?: string;
  run: () => void;
}

/** One rail destination, in ⌘N order. */
export interface PaletteView {
  id: ProjectView;
  label: string;
}

export interface PaletteEntriesContext {
  /** Whether a project is active — the task and project-view rows need one. */
  hasProject: boolean;
  /** The rail's project views in rail order; the index is the ⌘N shortcut. */
  views: PaletteView[];
  tasks: { meta: { id: string; title: string } }[];
  /** Tasks with every dependency landed — the ones a "Dispatch …" row makes sense for. */
  readyIds: ReadonlySet<string>;
  /** `import.meta.env.DEV` — the Gallery row exists only in a dev build. */
  dev: boolean;
  /** The project's saved views — one `Open view …` row each under `Views`. */
  savedViews?: { id: string; name: string }[];
  /** The task page or peek showing right now, which earns a `Copy link` row. */
  currentTaskId?: string | null;
  actions: {
    openCreateTask: () => void;
    openQuickAddTask: () => void;
    setProjectView: (view: ProjectView) => void;
    setGlobalView: (view: GlobalView) => void;
    peekTask: (taskId: string) => void;
    dispatchTask: (taskId: string) => void;
    openQuickCapture: () => void;
    toggleSidebar: () => void;
    openShortcuts: () => void;
    openSavedView?: (id: string) => void;
    /** Copies the task's `dispatch://` link. */
    copyTaskLink?: (taskId: string) => void;
  };
}

const GLOBAL_VIEWS: { id: GlobalView; label: string; shortcut?: string }[] = [
  { id: 'all-agents', label: 'All agents' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'overseer', label: 'Assistant', shortcut: 'G A' },
  { id: 'settings', label: 'Settings', shortcut: 'G S' },
];

/** The rows the command menu offers right now: actions (a `Copy link` when a task is up),
 * then navigation, the saved views, then one row per task (plus a "Dispatch …" row for
 * each ready one). Project-scoped rows are omitted while no project is active. */
export function buildPaletteEntries(
  ctx: PaletteEntriesContext
): PaletteEntry[] {
  const { actions } = ctx;
  const entries: PaletteEntry[] = [];

  if (ctx.hasProject) {
    entries.push(
      {
        id: 'action-new-task',
        label: 'New task',
        kind: 'action',
        section: 'actions',
        shortcut: 'C',
        run: actions.openCreateTask,
      },
      {
        id: 'action-quick-add-task',
        label: 'Quick add task…',
        kind: 'action',
        section: 'actions',
        run: actions.openQuickAddTask,
      },
      {
        id: 'action-plan-work',
        label: 'Plan work…',
        kind: 'action',
        section: 'actions',
        run: () => actions.setProjectView('plans'),
      },
      {
        id: 'action-quick-capture',
        label: 'Drop a thought',
        kind: 'action',
        section: 'actions',
        shortcut: '⌘D',
        run: actions.openQuickCapture,
      }
    );
    const { currentTaskId } = ctx;
    const { copyTaskLink } = actions;
    if (
      currentTaskId !== undefined &&
      currentTaskId !== null &&
      copyTaskLink !== undefined
    ) {
      entries.push({
        id: 'action-copy-link',
        label: 'Copy link',
        kind: 'action',
        section: 'actions',
        run: () => copyTaskLink(currentTaskId),
      });
    }
  }
  entries.push(
    {
      id: 'action-toggle-sidebar',
      label: 'Toggle sidebar',
      kind: 'action',
      section: 'actions',
      shortcut: '[',
      run: actions.toggleSidebar,
    },
    {
      id: 'action-shortcuts',
      label: 'Keyboard shortcuts',
      kind: 'action',
      section: 'actions',
      shortcut: '?',
      run: actions.openShortcuts,
    }
  );

  if (ctx.hasProject) {
    ctx.views.forEach((view, index) => {
      entries.push({
        id: `go-${view.id}`,
        label: `Go to ${view.label}`,
        kind: 'go to',
        section: 'navigation',
        shortcut: index < 9 ? `⌘${index + 1}` : undefined,
        run: () => actions.setProjectView(view.id),
      });
    });
  }
  for (const view of GLOBAL_VIEWS) {
    entries.push({
      id: `go-${view.id}`,
      label: `Go to ${view.label}`,
      kind: 'go to',
      section: 'navigation',
      shortcut: view.shortcut,
      run: () => actions.setGlobalView(view.id),
    });
  }
  // Dev-only primitive review surface — never registered in a production build.
  if (ctx.dev) {
    entries.push({
      id: 'go-gallery',
      label: 'Go to Gallery',
      kind: 'go to',
      section: 'navigation',
      run: () => actions.setGlobalView('gallery'),
    });
  }

  if (ctx.hasProject) {
    const { openSavedView } = actions;
    if (openSavedView !== undefined) {
      for (const view of ctx.savedViews ?? []) {
        entries.push({
          id: `view-${view.id}`,
          label: `Open view ${view.name}`,
          kind: 'view',
          section: 'views',
          run: () => openSavedView(view.id),
        });
      }
    }
    for (const doc of ctx.tasks) {
      entries.push({
        id: `task-${doc.meta.id}`,
        label: doc.meta.title,
        sublabel: doc.meta.id,
        kind: 'task',
        section: 'tasks',
        run: () => actions.peekTask(doc.meta.id),
      });
      if (ctx.readyIds.has(doc.meta.id)) {
        entries.push({
          id: `dispatch-${doc.meta.id}`,
          label: `Dispatch ${doc.meta.title}`,
          sublabel: doc.meta.id,
          kind: 'action',
          section: 'tasks',
          run: () => actions.dispatchTask(doc.meta.id),
        });
      }
    }
  }

  return entries;
}

/** One Docs row per search hit, in the daemon's rank order: a section hit opens
 * the doc scrolled to it, a hit before the first heading opens the doc's top. */
export function docHitEntries(
  hits: readonly DocHit[],
  openDoc: (docId: string, anchor: string | null) => void
): PaletteEntry[] {
  return hits.map((hit) => ({
    id: `doc:${hit.doc}#${hit.anchor}`,
    label: hit.heading === '' ? hit.title : `${hit.title} › ${hit.heading}`,
    sublabel: hit.handle,
    kind: 'doc',
    section: 'docs',
    run: () => openDoc(hit.doc, hit.anchor === '' ? null : hit.anchor),
  }));
}
