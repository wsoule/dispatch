// Thrown, never swallowed to `[]` — a failed `git ls-files` is not "no
// tracked files" and must not read as one.
export class TrackedFilesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrackedFilesError';
  }
}

// Runs `git ls-files`, injectable so tests can substitute a call-counting or
// failing fake without spawning a real process.
export type LsFilesRunner = (
  rootDir: string
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

// Bun's non-blocking spawn, not spawnSync — a sync spawn would freeze every
// other concurrent request for the subprocess's whole duration.
async function runLsFiles(
  rootDir: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['git', 'ls-files', '-z'], {
    cwd: rootDir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

// Memoizes `git ls-files` so a burst of task-subject requests shares one
// spawn — DepMapCache's async counterpart. A `get()` arriving mid-flight
// awaits the same call rather than starting a second one.
export class TrackedFilesCache {
  private cached: string[] | null = null;
  private pending: Promise<string[]> | null = null;

  constructor(
    private readonly rootDir: string,
    private readonly run: LsFilesRunner = runLsFiles
  ) {}

  async get(): Promise<string[]> {
    if (this.cached !== null) return this.cached;
    if (this.pending !== null) return this.pending;
    const promise = this.run(this.rootDir)
      .then((result) => {
        this.pending = null;
        if (result.exitCode !== 0) {
          throw new TrackedFilesError(
            `git ls-files failed: ${result.stderr.trim()}`
          );
        }
        const files = result.stdout.split('\0').filter((path) => path !== '');
        this.cached = files;
        return files;
      })
      .catch((err: unknown) => {
        this.pending = null;
        throw err;
      });
    this.pending = promise;
    return promise;
  }

  invalidate(): void {
    this.cached = null;
    this.pending = null;
  }
}
