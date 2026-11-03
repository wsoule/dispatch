import type { ShellWorkspace, ShellWorkspaceSwitcher } from '@dispatch/ui';

/** A project the brand row's switcher can list: its folder and its name. */
interface SwitchableProject {
  name: string;
  path: string;
}

interface ProjectWorkspaceInput {
  /** The project this window shows, or `null` while it resolves and on
   *  first launch (no registered project yet). */
  active: SwitchableProject | null;
  /** The registered projects, loaded lazily the first time the menu opens
   *  (empty until then). May or may not include the active one. */
  projects: readonly SwitchableProject[];
  onSelectProject: (path: string) => void;
  onAddProject: () => void;
  onOpenChange: (open: boolean) => void;
}

/** A project path with the home folder written as `~`. */
export function shortPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');
}

/**
 * Builds AppShell's brand-row workspace switcher from the desktop's
 * projects: each project is a workspace (id = its path, the `~` path as
 * the row's quiet hint, whole on hover), the active one marked current
 * even before the lazy list has loaded, the rest deduped by path (the
 * switcher lists them all by name). Picking
 * a row calls onSelectProject with its path (the picker leaves the current
 * row alone), and the connect row is "Add project…", run in place so the
 * host opens its AddProjectDialog. It replaces the old topbar project
 * menu: Settings and Sign out already live in AppShell's settings link
 * and signOut, and the first-task guide restarts from the palette
 * ("Restart the first-task guide"). Returns undefined while there is no
 * active project, so the brand row stays a plain link (resolving, first
 * launch).
 */
export function projectWorkspaceSwitcher(
  input: ProjectWorkspaceInput
): ShellWorkspaceSwitcher | undefined {
  const { active } = input;
  if (active === null) return undefined;
  const seen = new Set<string>([active.path]);
  const workspaces: ShellWorkspace[] = [toWorkspace(active, true)];
  for (const project of input.projects) {
    if (seen.has(project.path)) continue;
    seen.add(project.path);
    workspaces.push(toWorkspace(project, false));
  }
  return {
    workspaces,
    onSwitch: (id) => {
      input.onSelectProject(id);
    },
    connect: { label: 'Add project…', onSelect: input.onAddProject },
    label: 'Switch project',
    menuLabel: 'Project',
    groupLabel: 'Projects',
    onOpenChange: input.onOpenChange,
  };
}

// One project as a switcher row: its path is the id and, shortened, the hint.
function toWorkspace(
  project: SwitchableProject,
  current: boolean
): ShellWorkspace {
  return {
    id: project.path,
    name: project.name,
    hint: shortPath(project.path),
    current,
  };
}
