import { createContext, useContext } from 'react';

import type {
  GlobalView,
  ProjectView,
  SettingsPage,
  TaskTab,
} from '../../lib/appNav';

/** What a "+" on a status group, an epic's "add task", or a milestone row pre-fills into the
 * task creator. Every field is optional; the creator defaults the rest. */
export interface CreateTaskPreset {
  status?: string;
  epic?: string;
  milestone?: string;
}

/**
 * The shell's verbs, provided once by `App` and consumed anywhere below it with
 * `useShellActions()` — so a view, a row's context menu, or a toast can open a task, start a
 * create, or hide the rail without threading a callback through every prop layer in between.
 * Each verb is stable across renders (memoised in App) so it can sit in an effect's deps.
 */
export interface ShellActions {
  /** The full task page; `runId` pins Chat/Diff, else the task's latest run. */
  openTask: (taskId: string, tab?: TaskTab, runId?: string) => void;
  /** The Threads view; `messageId` opens the thread holding that message. */
  openThread: (messageId: string | null) => void;
  /** The task peek dialog over the current view. */
  peekTask: (taskId: string) => void;
  /** Opens the creator, pre-filled from `preset` (see `createPreset`). */
  openCreateTask: (preset?: CreateTaskPreset) => void;
  /** The preset the currently open creator was launched with, or `null`. */
  createPreset: CreateTaskPreset | null;
  closeCreateTask: () => void;
  openPalette: () => void;
  /** Hides or shows the rail (`[`). */
  toggleSidebar: () => void;
  sidebarHidden: boolean;
  /** The Overseer page; `prompt` pre-fills its composer. */
  openOverseer: (prompt?: string) => void;
  setProjectView: (view: ProjectView) => void;
  /** `page` lands Settings on one of its pages (`Connect Linear` → Integrations); it is
   * ignored for every other global view. */
  setGlobalView: (view: GlobalView, options?: { page?: SettingsPage }) => void;
  /** The `?` keyboard-shortcuts reference. */
  openShortcuts: () => void;
  /** Copies the task id to the clipboard and toasts. */
  copyTaskId: (taskId: string) => void;
}

const ShellActionsContext = createContext<ShellActions | null>(null);

export const ShellActionsProvider = ShellActionsContext.Provider;

/** Throws outside the provider rather than no-opping — a "New task" button that silently does
 * nothing is exactly the failure this seam exists to prevent. */
export function useShellActions(): ShellActions {
  const actions = useContext(ShellActionsContext);
  if (actions === null) {
    throw new Error(
      'useShellActions must be used inside <ShellActionsProvider>'
    );
  }
  return actions;
}
