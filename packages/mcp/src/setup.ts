import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// `dispatch-mcp setup`: one command that connects every agent client on this
// machine to Dispatch. It installs the server into ~/.dispatch/runtime, finds
// the clients installed (Claude Code, Codex, Cursor, Gemini CLI, Claude
// Desktop, Windsurf), points each at it with absolute paths (GUI apps do not
// get the shell's PATH, and npm's global prefix is often not on it either),
// installs Claude Code's hooks, and signs the machine in. Run again, it
// updates the entries it wrote before; it never rewrites a config file it
// cannot parse, and never touches anyone else's servers or hooks.

/** How a client should start this server. */
export interface Launch {
  command: string;
  args: string[];
}

export type StepResult =
  | { client: string; status: 'added' | 'updated' | 'present' }
  | { client: string; status: 'skipped'; reason: string };

export interface SetupEnv {
  home: string;
  platform: NodeJS.Platform;
  /** The Node binary running setup, which clients will start the server with. */
  node: string;
  /** Whether an executable is on PATH. */
  has(binary: string): boolean;
  /** Runs a command, returning its exit status. */
  run(command: string, args: string[]): number | null;
}

export function defaultSetupEnv(): SetupEnv {
  let node = process.execPath;
  try {
    node = realpathSync(node);
  } catch {
    // Keep the path as given.
  }
  return {
    home: homedir(),
    platform: process.platform,
    node,
    has: (binary) =>
      spawnSync(process.platform === 'win32' ? 'where' : 'which', [binary], {
        stdio: 'ignore',
        env: process.env,
      }).status === 0,
    run: (command, args) =>
      spawnSync(command, args, {
        stdio: 'ignore',
        env: process.env,
        timeout: 180_000,
      }).status,
  };
}

/** Where setup installs the server: a folder Dispatch owns, so no global npm
 *  permissions or PATH are involved. */
function runtimeDir(env: SetupEnv): string {
  return join(env.home, '.dispatch', 'runtime');
}

function runtimeBin(env: SetupEnv): string {
  return join(
    runtimeDir(env),
    'node_modules',
    '@dispatch-foo',
    'mcp',
    'dist',
    'bin.js'
  );
}

/** Installs this version into the runtime folder and returns how clients
 *  start it (absolute node + script); npx when it cannot be installed. */
export function installRuntime(env: SetupEnv, version: string): Launch {
  const npx: Launch = {
    command: 'npx',
    args: ['-y', `@dispatch-foo/mcp@${version}`],
  };
  if (!env.has('npm')) return npx;
  const dir = runtimeDir(env);
  mkdirSync(dir, { recursive: true });
  const status = env.run('npm', [
    'install',
    '--prefix',
    dir,
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    `@dispatch-foo/mcp@${version}`,
  ]);
  return status === 0 && existsSync(runtimeBin(env))
    ? { command: env.node, args: [runtimeBin(env)] }
    : npx;
}

// Whether a server entry or hook command is one setup wrote, so it may be
// updated: it starts this package, by name or from the runtime folder.
function ours(value: unknown): boolean {
  const text = JSON.stringify(value ?? '');
  return (
    text.includes('@dispatch-foo/mcp') ||
    text.includes('dispatch-mcp') ||
    text.includes('.dispatch/runtime')
  );
}

function same(a: unknown, b: Launch): boolean {
  return (
    JSON.stringify(a) === JSON.stringify({ command: b.command, args: b.args })
  );
}

function readJson(
  path: string
): Record<string, unknown> | null | 'unparseable' {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : 'unparseable';
  } catch {
    return 'unparseable';
  }
}

// The mode a config keeps: its own, or owner-only for a new one, since
// client configs carry other servers' tokens.
function modeOf(path: string): number {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return 0o600;
  }
}

// Through a temp file, so a crash never leaves half a config behind.
function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const mode = modeOf(path);
  const temp = `${path}.dispatch-${process.pid}`;
  writeFileSync(temp, text, { mode });
  chmodSync(temp, mode);
  renameSync(temp, path);
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

// Adds (or updates setup's own) mcpServers[name] in a JSON config: Cursor,
// Gemini, Claude Desktop and Windsurf share this shape. Under another name, an
// old `dispatch` entry setup wrote is moved to it.
function addToJsonConfig(
  client: string,
  path: string,
  launch: Launch,
  name = 'dispatch'
): StepResult {
  const config = readJson(path);
  if (config === 'unparseable')
    return {
      client,
      status: 'skipped',
      reason: `${path} is not plain JSON; add the server by hand`,
    };
  const current = config ?? {};
  const servers =
    typeof current.mcpServers === 'object' && current.mcpServers !== null
      ? (current.mcpServers as Record<string, unknown>)
      : {};
  const existing = servers[name];
  const legacy = name !== 'dispatch' && ours(servers.dispatch);
  if (existing !== undefined && same(existing, launch) && !legacy)
    return { client, status: 'present' };
  if (existing !== undefined && !ours(existing))
    return {
      client,
      status: 'skipped',
      reason: `it already has a different "${name}" server`,
    };
  const kept = legacy
    ? Object.fromEntries(
        Object.entries(servers).filter(([k]) => k !== 'dispatch')
      )
    : servers;
  writeJson(path, {
    ...current,
    mcpServers: {
      ...kept,
      [name]: { command: launch.command, args: launch.args },
    },
  });
  return {
    client,
    status: existing === undefined && !legacy ? 'added' : 'updated',
  };
}

// Claude Desktop reserves `dispatch` for its own feature and refuses a server
// by that name in Cowork and Code sessions.
const CLAUDE_DESKTOP_SERVER = 'dispatch-foo';

function claudeDesktopConfig(env: SetupEnv): string {
  if (env.platform === 'darwin')
    return join(
      env.home,
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json'
    );
  if (env.platform === 'win32')
    return join(
      process.env.APPDATA ?? join(env.home, 'AppData', 'Roaming'),
      'Claude',
      'claude_desktop_config.json'
    );
  return join(env.home, '.config', 'Claude', 'claude_desktop_config.json');
}

// Dispatch's Codex table, up to the next table or the end of the file.
const CODEX_TABLE =
  /^\[mcp_servers\.dispatch\][^\n]*\n(?:(?!\[)[^\n]*(?:\n|$))*/m;

// Codex keeps its servers in TOML; Dispatch's is its own table, replaced
// whole when setup wrote it before.
function addToCodex(path: string, launch: Launch): StepResult {
  const client = 'Codex';
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const toml = (s: string) => JSON.stringify(s);
  const block = `[mcp_servers.dispatch]\ncommand = ${toml(launch.command)}\nargs = [${launch.args.map(toml).join(', ')}]\n`;
  const found = CODEX_TABLE.exec(text);
  if (found !== null) {
    if (found[0].trim() === block.trim()) return { client, status: 'present' };
    if (!ours(found[0]))
      return {
        client,
        status: 'skipped',
        reason: 'it already has a different "dispatch" server',
      };
    const gap = /\n\s*\n$/.test(found[0]) ? '\n' : '';
    writeText(path, text.replace(CODEX_TABLE, `${block}${gap}`));
    return { client, status: 'updated' };
  }
  writeText(
    path,
    `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}\n${block}`
  );
  return { client, status: 'added' };
}

/** The shell command for a launch, each part quoted when it needs to be. */
export function commandLine(launch: Launch, rest: string[]): string {
  const quote = (s: string) =>
    /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
  return [launch.command, ...launch.args, ...rest].map(quote).join(' ');
}

/** The Claude Code hooks: the unread line at each prompt, one held stop for
 *  mail to the session, and a background wait that wakes an idle session. */
export function claudeHooks(launch: Launch): Record<string, unknown[]> {
  const hook = (event: string) => ({
    type: 'command',
    command: commandLine(launch, ['hook', 'claude', event]),
  });
  return {
    UserPromptSubmit: [{ hooks: [hook('UserPromptSubmit')] }],
    Stop: [
      {
        hooks: [
          hook('Stop'),
          {
            ...hook('wait'),
            asyncRewake: true,
            timeout: 3600,
            rewakeMessage: 'Dispatch: another agent sent you mail.',
            rewakeSummary: 'Dispatch mail',
          },
        ],
      },
    ],
  };
}

// An entry whose hooks are all Dispatch's (setup wrote it).
function dispatchEntry(entry: unknown): boolean {
  const hooks = (entry as { hooks?: unknown }).hooks;
  return (
    Array.isArray(hooks) &&
    hooks.length > 0 &&
    hooks.every((h) => {
      const command = (h as { command?: unknown }).command;
      return typeof command === 'string' && command.includes(' hook claude ');
    })
  );
}

// Puts Dispatch's hooks in ~/.claude/settings.json, replacing the ones setup
// wrote before and leaving every other hook alone.
function addClaudeHooks(env: SetupEnv, launch: Launch): StepResult {
  const client = 'Claude Code hooks';
  const path = join(env.home, '.claude', 'settings.json');
  const settings = readJson(path);
  if (settings === 'unparseable')
    return { client, status: 'skipped', reason: `${path} is not plain JSON` };
  const current = settings ?? {};
  const before =
    typeof current.hooks === 'object' && current.hooks !== null
      ? (current.hooks as Record<string, unknown[]>)
      : {};
  const hooks: Record<string, unknown[]> = {};
  let had = false;
  for (const [event, entries] of Object.entries(before)) {
    if (!Array.isArray(entries)) {
      hooks[event] = entries;
      continue;
    }
    const kept = entries.filter((e) => !dispatchEntry(e));
    if (kept.length !== entries.length) had = true;
    if (kept.length > 0) hooks[event] = kept;
  }
  for (const [event, entries] of Object.entries(claudeHooks(launch)))
    hooks[event] = [...(hooks[event] ?? []), ...entries];
  if (JSON.stringify(hooks) === JSON.stringify(before))
    return { client, status: 'present' };
  writeJson(path, { ...current, hooks });
  return { client, status: had ? 'updated' : 'added' };
}

/** Connects every client found on this machine; one result per client. */
export function connectClients(env: SetupEnv, launch: Launch): StepResult[] {
  const results: StepResult[] = [];
  const home = env.home;

  if (env.has('claude') || existsSync(join(home, '.claude'))) {
    if (!env.has('claude'))
      results.push({
        client: 'Claude Code',
        status: 'skipped',
        reason: 'the claude command is not on PATH',
      });
    else {
      // Replaced each time, so a re-run moves it to the current launch.
      const had =
        env.run('claude', ['mcp', 'remove', '-s', 'user', 'dispatch']) === 0;
      const added = env.run('claude', [
        'mcp',
        'add',
        '-s',
        'user',
        'dispatch',
        '--',
        launch.command,
        ...launch.args,
      ]);
      results.push(
        added === 0
          ? { client: 'Claude Code', status: had ? 'updated' : 'added' }
          : {
              client: 'Claude Code',
              status: 'skipped',
              reason: 'claude mcp add failed',
            }
      );
    }
    results.push(addClaudeHooks(env, launch));
  }
  if (env.has('codex') || existsSync(join(home, '.codex')))
    results.push(addToCodex(join(home, '.codex', 'config.toml'), launch));
  if (existsSync(join(home, '.cursor')))
    results.push(
      addToJsonConfig('Cursor', join(home, '.cursor', 'mcp.json'), launch)
    );
  if (env.has('gemini') || existsSync(join(home, '.gemini')))
    results.push(
      addToJsonConfig(
        'Gemini CLI',
        join(home, '.gemini', 'settings.json'),
        launch
      )
    );
  if (existsSync(dirname(claudeDesktopConfig(env))))
    results.push(
      addToJsonConfig(
        'Claude Desktop',
        claudeDesktopConfig(env),
        launch,
        CLAUDE_DESKTOP_SERVER
      )
    );
  if (existsSync(join(home, '.codeium', 'windsurf')))
    results.push(
      addToJsonConfig(
        'Windsurf',
        join(home, '.codeium', 'windsurf', 'mcp_config.json'),
        launch
      )
    );
  return results;
}

/** Whether `url` may be opened for a sign-in at `server`: the same origin,
 *  over https (or http to this machine). */
export function safeToOpen(url: string, server: string): boolean {
  try {
    const u = new URL(url);
    const s = new URL(server);
    const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    return (
      u.origin === s.origin &&
      (u.protocol === 'https:' || (u.protocol === 'http:' && loopback))
    );
  } catch {
    return false;
  }
}

/** Opens a URL in the person's browser, never through a shell; false when
 *  there is no way to. Callers pass only URLs safeToOpen accepts. */
export function openBrowser(url: string): boolean {
  if (process.env.DISPATCH_NO_BROWSER === '1') return false;
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawnSync(command, args, {
      stdio: 'ignore',
      env: process.env,
      timeout: 10_000,
    });
    return child.status === 0;
  } catch {
    return false;
  }
}
