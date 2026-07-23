import {
  ChevronLeft,
  FolderOpen,
  GitBranch,
  Loader2,
  Search,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import {
  cloneGithubRepo,
  type GithubRepo,
  listGithubRepos,
  pickDirectory,
} from '../../lib/tauri';
import { Button } from '../../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { Input } from '../../ui/input';

interface AddProjectDialogProps {
  /** Called with an absolute path once a project is chosen — either a locally picked folder
   * or a freshly cloned GitHub repo. Registers the project and switches the window to it (see
   * `App`'s `handleAddProject`); may reject (e.g. the path isn't a directory), in which case
   * the error is surfaced here rather than closing the dialog. */
  onAdd: (path: string) => Promise<void>;
  onClose: () => void;
}

type Mode = 'choose' | 'github';

/**
 * Add-project modal with two onboarding paths:
 *   - "Local folder…" opens a native folder picker, then registers the chosen directory.
 *   - "From GitHub" lists the authenticated user's repos (searchable), then clones the picked
 *     one into a parent directory chosen with the folder picker, then registers the checkout.
 *
 * Command errors — including `gh` missing/unauthenticated from `listGithubRepos`, and clone
 * failures — render inline as their raw error text. In the browser-dev harness the Tauri
 * commands reject/return null with clear messages, so the dialog degrades gracefully rather
 * than throwing.
 */
export function AddProjectDialog({ onAdd, onClose }: AddProjectDialogProps) {
  const [mode, setMode] = useState<Mode>('choose');
  const [error, setError] = useState<string | null>(null);
  // A busy state that blocks interaction: either a clone in progress or the final
  // register-and-switch step. The label distinguishes the two for the user.
  const [busy, setBusy] = useState<string | null>(null);

  // GitHub repo list, loaded lazily the first time the GitHub mode is opened.
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [reposLoading, setReposLoading] = useState(false);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (mode !== 'github' || repos !== null || reposLoading) return;
    setReposLoading(true);
    setError(null);
    listGithubRepos()
      .then((list) => setRepos(list))
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err))
      )
      .finally(() => setReposLoading(false));
  }, [mode, repos, reposLoading]);

  // Registers `path` and switches to it; leaves the dialog open showing the error if that
  // fails so the user can retry or pick something else.
  async function register(path: string, label: string) {
    setBusy(label);
    setError(null);
    try {
      await onAdd(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function pickLocalFolder() {
    setError(null);
    try {
      const path = await pickDirectory();
      if (path === null) return; // user cancelled the picker
      await register(path, 'Adding project…');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function cloneRepo(repo: GithubRepo) {
    setError(null);
    let parent: string | null;
    try {
      parent = await pickDirectory();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (parent === null) return; // user cancelled the parent-directory picker

    setBusy(`Cloning ${repo.name}…`);
    try {
      const path = await cloneGithubRepo(repo.nameWithOwner, parent);
      // Reuse `register`, but it manages `busy` itself — clear ours first so its label shows.
      setBusy(null);
      await register(path, 'Adding project…');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  const filteredRepos = (repos ?? []).filter((repo) => {
    const q = filter.trim().toLowerCase();
    if (q === '') return true;
    return (
      repo.nameWithOwner.toLowerCase().includes(q) ||
      repo.description.toLowerCase().includes(q)
    );
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && busy === null) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {mode === 'github' && (
              <button
                type="button"
                onClick={() => {
                  setMode('choose');
                  setError(null);
                }}
                className="text-muted-foreground hover:text-foreground -ml-1 rounded p-0.5"
                aria-label="Back"
              >
                <ChevronLeft className="size-4" />
              </button>
            )}
            {mode === 'github' ? 'Clone from GitHub' : 'Add project'}
          </DialogTitle>
          <DialogDescription>
            {mode === 'github'
              ? 'Pick a repository to clone, then choose where to put it.'
              : 'Open a local folder, or clone a repository from GitHub.'}
          </DialogDescription>
        </DialogHeader>

        {error !== null && (
          <div className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-[13px] whitespace-pre-wrap">
            {error}
          </div>
        )}

        {busy !== null ? (
          <div className="text-muted-foreground flex items-center justify-center gap-2 py-8 text-[13px]">
            <Loader2 className="size-4 animate-spin" />
            {busy}
          </div>
        ) : mode === 'choose' ? (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => void pickLocalFolder()}
              className="border-border hover:bg-accent flex items-center gap-3 rounded-lg border px-3 py-3 text-left transition-colors"
            >
              <FolderOpen className="text-muted-foreground size-5 shrink-0" />
              <span className="flex flex-col">
                <span className="text-foreground text-[13px] font-medium">
                  Local folder…
                </span>
                <span className="text-muted-foreground text-[12px]">
                  Add a project already on this machine
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => setMode('github')}
              className="border-border hover:bg-accent flex items-center gap-3 rounded-lg border px-3 py-3 text-left transition-colors"
            >
              <GitBranch className="text-muted-foreground size-5 shrink-0" />
              <span className="flex flex-col">
                <span className="text-foreground text-[13px] font-medium">
                  From GitHub
                </span>
                <span className="text-muted-foreground text-[12px]">
                  Clone one of your repositories
                </span>
              </span>
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="relative">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search repositories…"
                className="pl-8"
                autoFocus
              />
            </div>

            {reposLoading ? (
              <div className="text-muted-foreground flex items-center justify-center gap-2 py-8 text-[13px]">
                <Loader2 className="size-4 animate-spin" />
                Loading repositories…
              </div>
            ) : repos !== null && filteredRepos.length === 0 ? (
              <div className="text-muted-foreground px-1 py-8 text-center text-[13px]">
                {repos.length === 0
                  ? 'No repositories found.'
                  : 'No repositories match your search.'}
              </div>
            ) : (
              <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
                {filteredRepos.map((repo) => (
                  <button
                    key={repo.nameWithOwner}
                    type="button"
                    onClick={() => void cloneRepo(repo)}
                    title={repo.description || repo.nameWithOwner}
                    className="hover:bg-accent flex flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors"
                  >
                    <span className="text-foreground truncate text-[13px] font-medium">
                      {repo.nameWithOwner}
                    </span>
                    {repo.description !== '' && (
                      <span className="text-muted-foreground truncate text-[12px]">
                        {repo.description}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose} disabled={busy !== null}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
