import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// How this program starts another copy of itself. Published to npm it is a
// script (`node dist/bin.js`); bundled in the desktop app it is a standalone
// `bun build --compile` executable whose code lives inside the binary, where
// `import.meta.url` reads `file:///$bunfs/root/<name>` (`B:/~BUN/` on
// Windows). Spawning `<executable> <script> hub` there passes the script path
// as the first argument, which the executable does not expect, so a
// standalone copy is started with no script argument at all.

/** Whether this code runs inside a standalone compiled executable. */
export function isStandalone(url: string = import.meta.url): boolean {
  return url.includes('/$bunfs/') || url.includes('~BUN');
}

/** The command and leading arguments that start this program again, or null
 *  when its entry point cannot be found. */
export function selfLaunch(
  url: string = import.meta.url,
  execPath: string = process.execPath
): { command: string; args: string[] } | null {
  if (isStandalone(url)) return { command: execPath, args: [] };
  for (const name of ['./bin.js', './bin.ts']) {
    const path = fileURLToPath(new URL(name, url));
    if (existsSync(path)) return { command: execPath, args: [path] };
  }
  return null;
}

/** Drops a leading script path a standalone executable was handed by an
 *  older setup (`<executable> <runtime>/dist/bin.js hub`): the executable
 *  already is that script, so the path would be read as the command. */
export function stripScriptArg(argv: string[], standalone: boolean): string[] {
  if (!standalone) return argv;
  const first = argv[0];
  return first !== undefined && /[\\/]bin\.[cm]?[jt]s$/.test(first)
    ? argv.slice(1)
    : argv;
}
