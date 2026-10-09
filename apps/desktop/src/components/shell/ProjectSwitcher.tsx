import {
  ChevronDown,
  Cog,
  FolderGit2,
  LogOut,
  Palette,
  Plus,
  Repeat2,
} from 'lucide-react';

import { colorForProject } from '../../lib/projectColor';
import { InitialsAvatar } from '@/ui/ai/initials-avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';

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
  /** Dev-only; omitted in a production build. */
  onOpenGallery?: () => void;
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
  onOpenGallery,
  teamSession,
}: ProjectSwitcherProps) {
  if (projectName === null) {
    return noProjectYet ? (
      <button
        type="button"
        onClick={onAddProject}
        className="rounded-control text-muted-foreground hover:bg-surface-hover flex h-7 min-w-0 items-center gap-2 px-1.5 text-[13px] font-medium transition-colors duration-100 hover:text-(--text-secondary)"
      >
        <Plus className="size-3.5 shrink-0" />
        <span className="truncate">Add project…</span>
      </button>
    ) : (
      <span className="text-muted-foreground flex h-7 items-center px-1.5 text-[13px]">
        Resolving project…
      </span>
    );
  }

  const otherProjects = switchProjects.filter((p) => p.path !== projectPath);

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        title={projectPath ?? projectName}
        className="rounded-control hover:bg-surface-hover data-popup-open:bg-surface-hover flex h-7 min-w-0 items-center gap-2 pr-1.5 pl-1 text-left transition-colors duration-100 outline-none"
      >
        <InitialsAvatar
          square
          name={projectName}
          color={colorForProject(projectName)}
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-[550] text-(--text-secondary)">
          {projectName}
        </span>
        <ChevronDown
          aria-hidden
          className="text-muted-foreground size-3 shrink-0"
          strokeWidth={2}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuItem onClick={onOpenSettings}>
          <Cog />
          Settings
          <DropdownMenuShortcut>G then S</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onAddProject}>
          <Plus />
          Add project…
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Repeat2 />
            Switch project
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56">
            {otherProjects.length === 0 ? (
              <div className="text-muted-foreground px-2 py-1.5 text-[12px]">
                No other dispatch projects
              </div>
            ) : (
              otherProjects.map((p) => (
                <DropdownMenuItem
                  key={p.path}
                  title={p.path}
                  onClick={() => onSelectProject(p.path)}
                >
                  <InitialsAvatar
                    square
                    name={p.name}
                    color={colorForProject(p.name)}
                    className="size-3.5 text-[7px]"
                  />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {onOpenGallery !== undefined && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onOpenGallery}>
              <Palette />
              Gallery
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled
          className="text-muted-foreground"
          title={projectPath}
        >
          <FolderGit2 />
          {/* Trimmed from the start, so the project's own folder stays visible. */}
          <span className="min-w-0 flex-1 truncate [direction:rtl]">
            <span dir="ltr">{shortPath(projectPath)}</span>
          </span>
        </DropdownMenuItem>
        {teamSession !== undefined && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={teamSession.onSignOut}>
              <LogOut />
              <span className="min-w-0 flex-1 truncate">
                Sign out {teamSession.handle}
              </span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
