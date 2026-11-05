import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The desktop backend lists its commands in three places that must agree,
// and a drift only shows at runtime, as a command the app refuses:
// `generate_handler!` in src-tauri/src/lib.rs registers them, build.rs's
// COMMANDS gives each an `allow-<command>` permission (Tauri then refuses any
// app command no capability grants), and capabilities/default.json grants
// those to the main window. The page's `invoke` calls (all in lib/tauri.ts)
// must name registered commands.
const tauriDir = join(import.meta.dir, '../../src-tauri');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

// The command names inside `generate_handler![...]`, without their module.
function handlerCommands(): string[] {
  const lib = read(join(tauriDir, 'src/lib.rs'));
  const body = /generate_handler!\[([^\]]*)\]/.exec(lib)?.[1] ?? '';
  return [...body.matchAll(/(?:\w+::)*(\w+)\s*,?/g)].map((match) => match[1]);
}

// The quoted names in build.rs's COMMANDS list.
function manifestCommands(): string[] {
  const build = read(join(tauriDir, 'build.rs'));
  const body =
    /const COMMANDS: &\[&str\] = &\[([^\]]*)\]/.exec(build)?.[1] ?? '';
  return [...body.matchAll(/"(\w+)"/g)].map((match) => match[1]);
}

// The app-command permissions the capability grants, turned back into
// command names (`allow-open-url` is `open_url`).
function grantedCommands(): string[] {
  const capability = JSON.parse(
    read(join(tauriDir, 'capabilities/default.json'))
  ) as { permissions: (string | { identifier: string })[] };
  return capability.permissions
    .map((permission) =>
      typeof permission === 'string' ? permission : permission.identifier
    )
    .filter((identifier) => identifier.startsWith('allow-'))
    .map((identifier) =>
      identifier.slice('allow-'.length).replaceAll('-', '_')
    );
}

// Every command name the page invokes.
function invokedCommands(): string[] {
  const page = read(join(import.meta.dir, 'tauri.ts'));
  return [...page.matchAll(/invoke(?:<[^>]*>)?\(\s*'(\w+)'/g)].map(
    (match) => match[1]
  );
}

const sorted = (names: string[]) => [...new Set(names)].sort();

describe('desktop commands', () => {
  test('the handler registers a non-empty list with no repeats', () => {
    const names = handlerCommands();
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });

  test("build.rs's manifest lists exactly the registered commands", () => {
    expect(sorted(manifestCommands())).toEqual(sorted(handlerCommands()));
  });

  test('the main window is granted exactly the registered commands', () => {
    expect(sorted(grantedCommands())).toEqual(sorted(handlerCommands()));
  });

  test('every command the page invokes is registered', () => {
    const registered = new Set(handlerCommands());
    const invoked = sorted(invokedCommands());
    expect(invoked).toContain('download_workspace_file');
    expect(invoked).toContain('remember_window_theme');
    expect(invoked.filter((name) => !registered.has(name))).toEqual([]);
  });
});
