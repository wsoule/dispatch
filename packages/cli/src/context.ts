export interface CliContext {
  cwd: string;
  log: (line: string) => void;
  // Opens a URL in the user's default browser. Optional so existing callers
  // (and their tests) that never touch `dispatch ui` are unaffected — the
  // daemon commands fall back to a real `open`/`xdg-open` spawn (see
  // `defaultOpenBrowser` in commands/daemon.ts) when this is omitted, and
  // tests can inject a stub to assert on the URL without opening anything.
  openBrowser?: (url: string) => void;
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = 1
  ) {
    super(message);
    this.name = 'CliError';
  }
}
