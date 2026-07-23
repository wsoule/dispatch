export interface CliContext {
  cwd: string;
  log: (line: string) => void;
  // Opens a URL in the user's default browser. Optional so existing callers
  // (and their tests) that never touch `dispatch ui` are unaffected — the
  // daemon commands fall back to a real `open`/`xdg-open` spawn (see
  // `defaultOpenBrowser` in commands/daemon.ts) when this is omitted, and
  // tests can inject a stub to assert on the URL without opening anything.
  openBrowser?: (url: string) => void;
  // Launches the installed desktop app for a project root, used by the bare
  // `dispatch` default action when the app is present (see
  // `openDesktopOrBrowser` in commands/daemon.ts). Optional for the same
  // reason as `openBrowser`: real usage falls back to spawning `open -a
  // <productName>`, and tests inject a stub to assert on the root without
  // actually launching anything.
  openApp?: (rootDir: string) => void;
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
