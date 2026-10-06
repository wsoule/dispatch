import { useCallback, useState } from 'react';

const PREFIX = 'dispatch:overseer-dock:';

/** Moves `id` into the dock (newest first, no duplicates). */
export function docked(dock: readonly string[], id: string): string[] {
  return [id, ...dock.filter((d) => d !== id)];
}

/** Swaps the open conversation for a docked one: `open` goes in, `id` comes out. */
export function restored(
  dock: readonly string[],
  id: string,
  open: string | null
): string[] {
  const rest = dock.filter((d) => d !== id);
  return open === null || open === id ? rest : docked(rest, open);
}

function read(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(key) ?? '[]'
    );
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === 'string')
      : [];
  } catch {
    return [];
  }
}

function write(key: string, dock: string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(dock));
  } catch {
    // Blocked storage: the dock still works for this session.
  }
}

/** The Overseer conversations minimized to the side, per project, newest first. */
export function useOverseerDock(projectPath: string | null): {
  dock: string[];
  setDock: (next: (dock: string[]) => string[]) => void;
} {
  const key = PREFIX + (projectPath ?? '');
  const [state, setState] = useState(() => ({ key, dock: read(key) }));
  // A project switch reads that project's own dock.
  const current = state.key === key ? state : { key, dock: read(key) };
  if (current !== state) setState(current);
  const setDock = useCallback(
    (next: (dock: string[]) => string[]) => {
      setState((prev) => {
        const dock = next(prev.key === key ? prev.dock : read(key));
        write(key, dock);
        return { key, dock };
      });
    },
    [key]
  );
  return { dock: current.dock, setDock };
}
