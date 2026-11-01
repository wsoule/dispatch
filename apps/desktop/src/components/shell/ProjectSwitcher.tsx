import { Button, InitialsAvatar, Menu, type MenuEntry } from '@dispatch/ui';
import {
  ChevronDown,
  Cog,
  FolderGit2,
  LifeBuoy,
  LogOut,
  Plus,
  Repeat2,
} from 'lucide-react';

import styles from './ProjectSwitcher.module.css';

const ICON = { size: 14, strokeWidth: 1.8 } as const;

/** A project offered in the switcher's submenu. */
interface SwitchProject {
  path: string;
  name: string;
}

interface ProjectSwitcherProps {
  /** Active project, or `null` while resolving / when none exists. */
  projectName: string | null;
  projectPath: string | null;
  /** First-run state: no registry entry, no launch arg — the switcher offers "Add
   * project…" in place of a project. */
  noProjectYet: boolean;
  /** Owned by App, which loads the other projects lazily the first time this opens. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  switchProjects: SwitchProject[];
  onSelectProject: (path: string) => void;
  onAddProject: () => void;
  onOpenSettings: () => void;
  /** Help: brings the first-task guide back for this project. */
  onRestartGuide?: () => void;
  /** Set only for a teammate on a team-local daemon: who they are signed in
   *  as, and how to stop. Someone at their own machine has no session to end. */
  teamSession?: { handle: string; onSignOut: () => void };
}

/**
 * The rail's workspace switcher (Linear §2): an 18px initials square in the project's
 * colour, the name, a tiny chevron. Its menu is where Settings lives now that it has left
 * the rail, alongside adding a project and switching to another.
 */
/** A project path with the home folder written as `~`. */
export function shortPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');
}

export function ProjectSwitcher({
  projectName,
  projectPath,
  noProjectYet,
  open,
  onOpenChange,
  switchProjects,
  onSelectProject,
  onAddProject,
  onOpenSettings,
  onRestartGuide,
  teamSession,
}: ProjectSwitcherProps) {
  if (projectName === null) {
    return noProjectYet ? (
      <Button
        variant="quiet"
        size="sm"
        icon={<Plus {...ICON} />}
        onClick={onAddProject}
      >
        Add project…
      </Button>
    ) : (
      <span className={styles.resolving}>Resolving project…</span>
    );
  }

  const otherProjects = switchProjects.filter((p) => p.path !== projectPath);
  const items: MenuEntry[] = [
    {
      id: 'settings',
      label: 'Settings',
      icon: <Cog {...ICON} />,
      shortcut: 'G then S',
      onSelect: onOpenSettings,
    },
    {
      id: 'add',
      label: 'Add project…',
      icon: <Plus {...ICON} />,
      onSelect: onAddProject,
    },
    {
      kind: 'submenu',
      id: 'switch',
      label: 'Switch project',
      icon: <Repeat2 {...ICON} />,
      emptyLabel: 'No other dispatch projects',
      items: otherProjects.map((p) => ({
        id: p.path,
        label: p.name,
        title: p.path,
        icon: <InitialsAvatar name={p.name} />,
        onSelect: () => onSelectProject(p.path),
      })),
    },
  ];
  if (onRestartGuide !== undefined) {
    items.push(
      { kind: 'separator', id: 'help-rule' },
      {
        kind: 'group',
        id: 'help',
        label: 'Help',
        items: [
          {
            id: 'restart-guide',
            label: 'Restart the guide',
            icon: <LifeBuoy {...ICON} />,
            onSelect: onRestartGuide,
          },
        ],
      }
    );
  }
  items.push(
    { kind: 'separator', id: 'path-rule' },
    {
      id: 'path',
      // Trimmed from the start, so the project's own folder stays visible.
      label: (
        <span className={styles.path}>
          <span dir="ltr">{shortPath(projectPath ?? projectName)}</span>
        </span>
      ),
      icon: <FolderGit2 {...ICON} />,
      title: projectPath ?? undefined,
      disabled: true,
      onSelect: () => {},
    }
  );
  if (teamSession !== undefined) {
    items.push(
      { kind: 'separator', id: 'session-rule' },
      {
        id: 'sign-out',
        label: `Sign out ${teamSession.handle}`,
        icon: <LogOut {...ICON} />,
        onSelect: teamSession.onSignOut,
      }
    );
  }

  return (
    <Menu
      label="Project"
      items={items}
      open={open}
      onOpenChange={onOpenChange}
      trigger={(props) => (
        <Button
          {...props}
          variant="quiet"
          size="sm"
          title={projectPath ?? projectName}
          className={styles.trigger}
          icon={<InitialsAvatar name={projectName} />}
          iconAfter={<ChevronDown size={12} strokeWidth={2} />}
        >
          {projectName}
        </Button>
      )}
    />
  );
}
