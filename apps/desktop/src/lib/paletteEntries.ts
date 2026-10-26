// The command menu's rows, built as plain data so the sections and their shortcut hints are
// testable without React. `adapters/palette.ts` turns them into @dispatch/ui PaletteItems
// (section headings, default icons, keycaps) for the Gr8r palette hosted by
// `components/shell/CommandPalette.tsx`.

import type { DocHit } from '@dispatch/client';
import type { ReactNode } from 'react';

import { type GlobalView, HOST_VIEWS, type ProjectView } from './appNav';
import { docHref, PROJECTS_HREF } from './routes';
import { hrefFor } from './shellRoutes';

export type PaletteSection =
  | 'tasks'
  | 'docs'
  | 'navigation'
  | 'actions'
  | 'inbox'
  | 'views';

export interface PaletteEntry {
  id: string;
  label: string;
  /** Matched too: a task's id, a doc's handle. */
  sublabel?: string;
  /** What the row is — "task", "go to", "action"; kept as data, never printed. */
  kind: string;
  section: PaletteSection;
  icon?: ReactNode;
  /** The keycap hint, as it is printed: `⌘1`, `C`, `G A` (`⌘` stands for the
   * platform's modifier; the palette prints its label). */
  shortcut?: string;
  /** The place the row opens, as a `lib/routes.ts` href, when it is a place: a
   * navigation row, a doc hit. `run` still does the opening. */
  href?: string;
  run: () => void;
}

/** A page the palette can open. */
interface PaletteView {
  id: ProjectView;
  label: string;
}

export interface PaletteEntriesContext {
  /** Whether a project is active — the task and project-view rows need one. */
  hasProject: boolean;
  tasks: { meta: { id: string; title: string } }[];
  /** Tasks with every dependency landed — the ones a "Dispatch …" row makes sense for. */
  readyIds: ReadonlySet<string>;
  /** The project's saved views — one `Open view …` row each under `Views`. */
  savedViews?: { id: string; name: string }[];
  /** The task page or peek showing right now, which earns a `Copy link` row. */
  currentTaskId?: string | null;
  /** A teammate below the operator tier: Terminals and Design are left out. */
  hideHostViews?: boolean;
  actions: {
    openCreateTask: () => void;
    openQuickAddTask: () => void;
    setProjectView: (view: ProjectView) => void;
    setGlobalView: (view: GlobalView) => void;
    peekTask: (taskId: string) => void;
    dispatchTask: (taskId: string) => void;
    openQuickCapture: () => void;
    openShortcuts: () => void;
    openSavedView?: (id: string) => void;
    /** Copies the task's `dispatch://` link. */
    copyTaskLink?: (taskId: string) => void;
    /** Brings the first-task guide back for the active project. */
    restartGuide?: () => void;
  };
}

// The pages under Tasks with no sidebar row: Files, Terminals, the Projects
// register (also the Projects section's "All") and Live (also the Runs page's
// link). Each page's route head is its view name (`#/files`, `#/live`: the
// `pageRoute`s of lib/routes.ts), which the test checks through parseHref.
const TASKS_PAGES: (PaletteView & { href: string })[] = [
  { id: 'files', label: 'Files', href: '#/files' },
  { id: 'terminals', label: 'Terminals', href: '#/terminals' },
  { id: 'projects', label: 'Projects', href: PROJECTS_HREF },
  { id: 'live', label: 'Live', href: '#/live' },
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
        // Planning happens in the Overseer conversation.
        run: () => actions.setGlobalView('overseer'),
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
  entries.push({
    id: 'action-shortcuts',
    label: 'Keyboard shortcuts',
    kind: 'action',
    section: 'actions',
    shortcut: '?',
    run: actions.openShortcuts,
  });
  const { restartGuide } = actions;
  if (ctx.hasProject && restartGuide !== undefined) {
    entries.push({
      id: 'action-restart-guide',
      label: 'Restart the first-task guide',
      kind: 'help',
      section: 'actions',
      run: restartGuide,
    });
  }

  entries.push(
    {
      id: 'go-overseer',
      label: 'Go to Overseer',
      kind: 'go to',
      section: 'navigation',
      shortcut: '⌘1',
      href: hrefFor('overseer'),
      run: () => actions.setGlobalView('overseer'),
    },
    {
      id: 'go-board',
      label: 'Go to Tasks',
      kind: 'go to',
      section: 'navigation',
      shortcut: '⌘2',
      href: hrefFor('issues'),
      run: () => actions.setProjectView('board'),
    },
    {
      id: 'go-settings',
      label: 'Go to Settings',
      kind: 'go to',
      section: 'navigation',
      shortcut: '⌘,',
      href: hrefFor('settings'),
      run: () => actions.setGlobalView('settings'),
    }
  );
  if (ctx.hasProject) {
    entries.push(
      {
        id: 'go-timeline',
        label: 'Go to Timeline',
        kind: 'go to',
        section: 'navigation',
        shortcut: 'G L',
        href: hrefFor('timeline'),
        run: () => actions.setProjectView('timeline'),
      },
      {
        id: 'go-graph',
        label: 'Go to Graph',
        kind: 'go to',
        section: 'navigation',
        shortcut: 'G G',
        href: hrefFor('graph'),
        run: () => actions.setProjectView('graph'),
      }
    );
  }
  if (ctx.hasProject) {
    for (const page of TASKS_PAGES) {
      if (ctx.hideHostViews === true && HOST_VIEWS.has(page.id)) continue;
      entries.push({
        id: `go-${page.id}`,
        label: `Open ${page.label}`,
        kind: 'go to',
        section: 'navigation',
        href: page.href,
        run: () => actions.setProjectView(page.id),
      });
    }
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
  return hits.map((hit) => {
    const anchor = hit.anchor === '' ? null : hit.anchor;
    return {
      id: `doc:${hit.doc}#${hit.anchor}`,
      label: hit.heading === '' ? hit.title : `${hit.title} › ${hit.heading}`,
      sublabel: hit.handle,
      kind: 'doc',
      section: 'docs',
      href: docHref(hit.doc, anchor),
      run: () => openDoc(hit.doc, anchor),
    };
  });
}

/** The rows for talking to someone or opening a room; homes are never listed elsewhere. */
export function addressEntries(input: {
  people: readonly { ref: string; name: string }[];
  rooms: readonly string[];
  peers: readonly { alias: string; status: string }[];
  me: string | null;
  open: (address: string) => void;
}): PaletteEntry[] {
  const people = input.people
    .filter((p) => p.ref !== input.me)
    .map((p) => ({
      id: `message-${p.ref}`,
      label: `Message ${p.name}`,
      kind: 'message',
      section: 'navigation' as const,
      run: () => input.open(p.ref),
    }));
  const peers = input.peers
    .filter((p) => p.status === 'active')
    .map((p) => ({
      id: `message-a2a:${p.alias}`,
      label: `Message ${p.alias} (outside)`,
      kind: 'message',
      section: 'navigation' as const,
      run: () => input.open(`a2a:${p.alias}`),
    }));
  // Milestone rooms open from their milestone, not by name.
  const rooms = input.rooms
    .filter((name) => !name.startsWith('epic/'))
    .map((name) => ({
      id: `room-${name}`,
      label: `Open #${name}`,
      kind: 'room',
      section: 'navigation' as const,
      run: () => input.open(`channel:${name}`),
    }));
  return [...people, ...peers, ...rooms];
}
