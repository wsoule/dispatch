export type ParsedRootArg =
  | { ok: true; root: string }
  | { ok: false; error: string };

// Parses `--root <dir>` out of argv for the dispatch-mcp bin. Pure and
// side-effect-free (no process.exit here) so it's unit-testable on its own
// — bin.ts is a top-level script that starts a real stdio transport on
// import, so the parsing logic has to live somewhere importing it doesn't
// also spin up a server.
export function parseRootArg(
  argv: string[],
  cwd: string = process.cwd()
): ParsedRootArg {
  const i = argv.indexOf('--root');
  if (i === -1) return { ok: true, root: cwd };
  const value = argv[i + 1];
  // A missing value (--root was the last arg) or a value that looks like
  // another flag (starts with `-`) both mean --root effectively has no
  // directory — silently falling back to cwd there would run the server
  // against the wrong root without telling anyone.
  if (value === undefined || value.startsWith('-')) {
    return { ok: false, error: '--root requires a directory argument' };
  }
  return { ok: true, root: value };
}
