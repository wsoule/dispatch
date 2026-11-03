import {
  Button,
  Dialog,
  EmptyState,
  Notice,
  Register,
  RegisterCell,
  RegisterRow,
  SearchField,
  Spinner,
} from '@dispatch/ui';
import { ChevronLeft, FolderOpen, GitBranch } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import {
  cloneGithubRepo,
  type GithubRepo,
  listGithubRepos,
  pickDirectory,
} from '../../lib/tauri';
import styles from './AddProjectDialog.module.css';

type Mode = 'choose' | 'github';

interface AddProjectDialogProps {
  /** Called with an absolute path once a project is chosen — either a locally picked folder
   * or a freshly cloned GitHub repo. Registers the project and switches the window to it (see
   * `App`'s `handleAddProject`); may reject (e.g. the path isn't a directory), in which case
   * the error is surfaced here rather than closing the dialog. */
  onAdd: (path: string) => Promise<void>;
  onClose: () => void;
  /** Which pane to open on; 'github' skips the choice when the caller already asked for GitHub. */
  initialMode?: Mode;
}

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
export function AddProjectDialog({
  onAdd,
  onClose,
  initialMode = 'choose',
}: AddProjectDialogProps) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [error, setError] = useState<string | null>(null);
  // A busy state that blocks interaction: either a clone in progress or the final
  // register-and-switch step. The label distinguishes the two for the user.
  const [busy, setBusy] = useState<string | null>(null);

  // GitHub repo list, loaded lazily the first time the GitHub mode is opened.
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [reposLoading, setReposLoading] = useState(false);
  const [filter, setFilter] = useState('');
  // Choosing "From GitHub" swaps the dialog's body for the repo list; the caret follows
  // that choice into its search box.
  const filterRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (mode === 'github') filterRef.current?.focus();
  }, [mode]);

  // Asks for the repositories once each time the GitHub pane opens without a list. A
  // failed load (gh missing or signed out) says so and waits for the person: Back, then
  // From GitHub again, asks once more. Keyed on the loading flag instead, a failure (the
  // list still null, loading back to false) asked again at once, over and over.
  const reposAsked = useRef(false);
  useEffect(() => {
    if (mode !== 'github') {
      reposAsked.current = false;
      return;
    }
    if (repos !== null || reposAsked.current) return;
    reposAsked.current = true;
    setReposLoading(true);
    setError(null);
    listGithubRepos()
      .then((list) => setRepos(list))
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err))
      )
      .finally(() => setReposLoading(false));
  }, [mode, repos]);

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
      onClose={onClose}
      dismissible={busy === null}
      contentKey={mode}
      titleAction={
        mode === 'github' ? (
          <Button
            variant="quiet"
            size="sm"
            icon={<ChevronLeft size={14} strokeWidth={1.8} />}
            aria-label="Back"
            onClick={() => {
              setMode('choose');
              setError(null);
            }}
          />
        ) : undefined
      }
      title={mode === 'github' ? 'Clone from GitHub' : 'Add project'}
      description={
        mode === 'github'
          ? 'Pick a repository to clone, then choose where to put it.'
          : 'Open a local folder, or clone a repository from GitHub.'
      }
      actions={
        <Button variant="secondary" onClick={onClose} disabled={busy !== null}>
          Cancel
        </Button>
      }
    >
      <div className={styles.body}>
        {error !== null && (
          <Notice tone="danger" role="alert">
            <span className={styles.error}>{error}</span>
          </Notice>
        )}

        {busy !== null ? (
          <div className={styles.waiting}>
            <Spinner label="" />
            {busy}
          </div>
        ) : mode === 'choose' ? (
          <div className={styles.choices}>
            <button
              type="button"
              className={styles.choice}
              onClick={() => void pickLocalFolder()}
            >
              <FolderOpen
                className={styles.choiceIcon}
                size={20}
                strokeWidth={1.6}
                aria-hidden="true"
              />
              <span className={styles.choiceText}>
                <span className={styles.choiceName}>Local folder…</span>
                <span className={styles.choiceNote}>
                  Add a project already on this machine
                </span>
              </span>
            </button>
            <button
              type="button"
              className={styles.choice}
              onClick={() => setMode('github')}
            >
              <GitBranch
                className={styles.choiceIcon}
                size={20}
                strokeWidth={1.6}
                aria-hidden="true"
              />
              <span className={styles.choiceText}>
                <span className={styles.choiceName}>From GitHub</span>
                <span className={styles.choiceNote}>
                  Clone one of your repositories
                </span>
              </span>
            </button>
          </div>
        ) : (
          <div className={styles.github}>
            {/* Escape in a field with text clears it; in an empty field it
                reaches the dialog, which closes. */}
            <SearchField
              inputRef={filterRef}
              value={filter}
              onChange={setFilter}
              label="Search repositories"
              placeholder="Search repositories…"
            />

            {reposLoading ? (
              <div className={styles.waiting}>
                <Spinner label="" />
                Loading repositories…
              </div>
            ) : repos === null ? null : filteredRepos.length === 0 ? (
              <EmptyState icon={null}>
                {repos.length === 0
                  ? 'No repositories found.'
                  : 'No repositories match your search.'}
              </EmptyState>
            ) : (
              <div className={styles.repos}>
                <Register
                  label="Repositories"
                  columns="minmax(0, 1fr)"
                  stackWithin={480}
                  stackedColumns="minmax(0, 1fr)"
                >
                  {filteredRepos.map((repo) => (
                    <RegisterRow
                      key={repo.nameWithOwner}
                      onActivate={() => void cloneRepo(repo)}
                      // The description is part of the row's name (the
                      // stretched button's words replace the cells') and
                      // whole on hover, where one line cuts it.
                      rowLabel={
                        repo.description === ''
                          ? `Clone ${repo.nameWithOwner}`
                          : `Clone ${repo.nameWithOwner}, ${repo.description}`
                      }
                      title={repo.description || repo.nameWithOwner}
                    >
                      <RegisterCell
                        variant="name"
                        sub={
                          repo.description === '' ? undefined : repo.description
                        }
                      >
                        {/* owner/name is read by machines (gh), so mono. */}
                        <span className={styles.repoName}>
                          {repo.nameWithOwner}
                        </span>
                      </RegisterCell>
                    </RegisterRow>
                  ))}
                </Register>
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
