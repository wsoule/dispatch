import type { DraftRecord } from '@dispatch/client';
import { Bell, Check, ChevronsUpDown, Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';

import { colorForProject } from '../../lib/projectColor';
import { isTauri } from '../../lib/tauri';
import { DraftTray } from './DraftTray';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Kbd } from '@/ui/kbd';

/** A project offered in the titlebar's switcher dropdown. */
interface SwitchProject {
  path: string;
  name: string;
}

interface TitleBarProps {
  /** Active project, or `null` while resolving / when none exists. */
  projectName: string | null;
  projectPath: string | null;
  /** First-run state: no registry entry, no launch arg — the switcher slot offers "Add
   * project…" instead of a project. */
  noProjectYet: boolean;
  switcherOpen: boolean;
  onToggleSwitcher: () => void;
  switchProjects: SwitchProject[];
  onSelectProject: (path: string) => void;
  onAddProject: () => void;
  onOpenPalette: () => void;
  unreadCount: number;
  onToggleInbox: () => void;
  drafts: DraftRecord[];
  onOpenDraft: (id: string) => void;
  onDismissDraft: (id: string) => void;
}

/** True on the packaged macOS app, where the window uses `titleBarStyle: "Overlay"` and the
 * native traffic lights float over the top-left of this bar, so it needs a left inset. In a
 * plain browser (dev harness) or on Linux there are no overlaid controls to dodge. */
function isMacTauri(): boolean {
  return (
    isTauri() &&
    typeof navigator !== 'undefined' &&
    navigator.userAgent.includes('Macintosh')
  );
}

/** Whether to reserve space for the macOS traffic lights. They auto-hide in native
 * fullscreen, so the inset collapses there; fullscreen is re-checked on every window resize
 * (entering/leaving fullscreen always resizes, and `isFullscreen` is the reliable signal). */
function useTrafficLightInset(): boolean {
  const [inset, setInset] = useState(() => isMacTauri());

  useEffect(() => {
    if (!isMacTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      const update = async () => {
        const fullscreen = await win.isFullscreen();
        if (!cancelled) setInset(!fullscreen);
      };
      void update();
      const stop = await win.onResized(() => void update());
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return inset;
}

/** The window's custom titlebar: a drag-region strip at traffic-light height holding the
 * project switcher (left), the command-palette search pill (center), and the drafts tray +
 * notifications bell (right). Only elements carrying `data-tauri-drag-region` start a window
 * drag, so every interactive child stays clickable. */
export function TitleBar({
  projectName,
  projectPath,
  noProjectYet,
  switcherOpen,
  onToggleSwitcher,
  switchProjects,
  onSelectProject,
  onAddProject,
  onOpenPalette,
  unreadCount,
  onToggleInbox,
  drafts,
  onOpenDraft,
  onDismissDraft,
}: TitleBarProps) {
  const trafficLightInset = useTrafficLightInset();
  const otherProjects = switchProjects.filter((p) => p.path !== projectPath);

  return (
    <header
      data-tauri-drag-region
      className={cn(
        'border-border bg-sidebar relative flex h-10 shrink-0 items-center gap-2 border-b pr-3',
        trafficLightInset ? 'pl-[76px]' : 'pl-3'
      )}
    >
      {projectName !== null ? (
        <DropdownMenu
          open={switcherOpen}
          onOpenChange={() => onToggleSwitcher()}
        >
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              title={projectPath ?? projectName}
              className="text-foreground hover:text-foreground h-7 max-w-56 rounded-md px-2 text-[13px] font-medium transition-colors duration-150"
            >
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: colorForProject(projectName) }}
              />
              <span className="min-w-0 flex-1 truncate">{projectName}</span>
              <ChevronsUpDown className="text-muted-foreground size-3.5 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem disabled className="text-muted-foreground">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: colorForProject(projectName) }}
              />
              <span className="text-foreground min-w-0 flex-1 truncate">
                {projectName}
              </span>
              <Check className="text-primary size-3.5" />
            </DropdownMenuItem>
            {otherProjects.length === 0 ? (
              <div className="text-muted-foreground px-2 py-1.5 text-[12px]">
                No other dispatch projects
              </div>
            ) : (
              otherProjects.map((p) => (
                <DropdownMenuItem
                  key={p.path}
                  title={p.path}
                  onSelect={() => onSelectProject(p.path)}
                >
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: colorForProject(p.name) }}
                  />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                </DropdownMenuItem>
              ))
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onAddProject()}>
              <Plus className="text-muted-foreground size-3.5" />
              <span className="flex-1">Add project</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : noProjectYet ? (
        <Button
          type="button"
          variant="ghost"
          onClick={() => onAddProject()}
          className="text-muted-foreground hover:text-foreground h-7 rounded-md px-2 text-[13px] font-normal transition-colors duration-150"
        >
          <Plus className="size-3.5 shrink-0" />
          <span>Add project…</span>
        </Button>
      ) : (
        <span className="text-muted-foreground px-2 text-[13px]">
          Resolving project…
        </span>
      )}

      {/* Center search pill, absolutely centered so it doesn't drift with the side clusters. */}
      <button
        type="button"
        onClick={() => onOpenPalette()}
        className="border-border bg-field text-muted-foreground hover:text-foreground absolute left-1/2 flex h-6.5 w-64 -translate-x-1/2 items-center gap-2 rounded-md border px-2.5 text-[12px] transition-colors duration-150"
      >
        <Search className="size-3.5 shrink-0" />
        <span className="flex-1 text-left">Search or jump to…</span>
        <Kbd>⌘K</Kbd>
      </button>

      <div className="flex-1" data-tauri-drag-region />

      <DraftTray
        drafts={drafts}
        collapsed
        onOpenDraft={onOpenDraft}
        onDismissDraft={onDismissDraft}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        title="Notifications"
        onClick={() => onToggleInbox()}
        className="text-muted-foreground hover:text-foreground relative shrink-0 transition-colors duration-150"
      >
        <Bell className="size-4" strokeWidth={2} />
        {/* Same attention affordance as the old sidebar row: a bare accent dot, with the
            actual count carried by the aria-label rather than a numeric pill. */}
        {unreadCount > 0 && (
          <span
            aria-hidden
            className="bg-primary absolute top-0.5 right-0.5 size-1.5 rounded-full"
          />
        )}
      </Button>
    </header>
  );
}
