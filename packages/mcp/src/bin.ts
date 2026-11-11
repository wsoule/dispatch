#!/usr/bin/env node
import { exemptLoopbackFromProxy } from '@dispatch-foo/core';

import { parseRootArg } from './argv.js';
import type { HookClient } from './hook.js';
import {
  HOOK_CLIENTS,
  hookConfigText,
  runHook,
  WAIT_TIMEOUT_SEC,
  waitForMail,
} from './hook.js';
import { isStandalone, stripScriptArg } from './self.js';
import { MCP_SERVER_VERSION, runStdioServer } from './server.js';

// Every call to dispatchd carries a bearer token to http://127.0.0.1, and a
// proxy in the agent's environment (HTTP_PROXY, ALL_PROXY) would otherwise
// receive it: before any fetch, the loopback addresses join NO_PROXY.
exemptLoopbackFromProxy();

const argv = stripScriptArg(process.argv.slice(2), isStandalone());

const USAGE = `dispatch-mcp ${MCP_SERVER_VERSION}: Dispatch's MCP server.

Usage:
  dispatch-mcp [--root <dir>]   Serve MCP over stdio (what agent clients run)
  dispatch-mcp setup            Connect every agent client on this machine
                                (Claude Code, Codex, Cursor, Gemini CLI, Claude
                                Desktop, Windsurf), then sign in to your team
  dispatch-mcp join <link>      Accept a team invite: setup, then sign in to
                                the team the invite is for
  dispatch-mcp login            Sign this machine in to your team
  dispatch-mcp logout           Sign this machine out of its team
  dispatch-mcp status           Show the team, sign-in and client connections
  dispatch-mcp hub              Run the machine hub in the foreground
  dispatch-mcp hooks <client>   Print the hook config for a client
  dispatch-mcp --version        Print the version
`;

// Help and version never run anything: `setup --help` used to run setup.
if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
  process.stdout.write(`${MCP_SERVER_VERSION}\n`);
  process.exit(0);
}

// `hook <client> <event>` runs as an agent client's hook: it must print
// valid hook output or nothing, and never fail the client's turn.
if (argv[0] === 'hook') {
  const client = argv[1] as HookClient;
  // `hook claude wait` runs in the background (asyncRewake): it exits 2 with
  // the wake line on stderr when mail arrives, else 0 when its time is up.
  if (client === 'claude' && argv[2] === 'wait') {
    const line = await waitForMail(await readStdin(), process.cwd(), {
      timeoutMs: (WAIT_TIMEOUT_SEC - 30) * 1000,
      pollMs: 3000,
    }).catch(() => null);
    if (line !== null) {
      process.stderr.write(`${line}\n`);
      process.exit(2);
    }
    process.exit(0);
  }
  if (HOOK_CLIENTS.includes(client) && argv[2] !== undefined) {
    const input = await readStdin();
    const output = await runHook(client, argv[2], input, process.cwd()).catch(
      () => ''
    );
    if (output !== '') process.stdout.write(`${output}\n`);
  }
  process.exit(0);
}

if (argv[0] === 'hooks') {
  const client = argv[1] as HookClient;
  if (!HOOK_CLIENTS.includes(client)) {
    console.error(`usage: dispatch-mcp hooks <${HOOK_CLIENTS.join('|')}>`);
    process.exit(1);
  }
  process.stdout.write(hookConfigText(client));
  process.exit(0);
}

// `login` signs this machine in to a team; `setup` first connects every
// agent client on the machine, then signs in.
// `join <link>` is setup plus a sign-in that carries the invite, so one
// approval in the browser joins the team and signs this machine in.
if (argv[0] === 'login' || argv[0] === 'setup' || argv[0] === 'join') {
  const { interactiveLogin, parseJoinLink } = await import('./login.js');
  let join: { server: string; token: string } | undefined;
  if (argv[0] === 'join') {
    const parsed = parseJoinLink(argv[1] ?? '');
    if ('error' in parsed) {
      console.error(`dispatch-mcp join: ${parsed.error}`);
      process.exit(1);
    }
    join = parsed;
  }
  if (argv[0] === 'setup' || argv[0] === 'join') {
    const { connectClients, defaultSetupEnv, installRuntime } =
      await import('./setup.js');
    const setupEnv = defaultSetupEnv();
    const launch = installRuntime(setupEnv, MCP_SERVER_VERSION);
    console.log(
      launch.command === 'npx'
        ? '  -  Could not install into ~/.dispatch/runtime; clients will start Dispatch with npx'
        : launch.command === setupEnv.standalone
          ? `  ✓  Clients will start the Dispatch app's own copy (${MCP_SERVER_VERSION})`
          : `  ✓  Dispatch ${MCP_SERVER_VERSION} installed in ~/.dispatch/runtime`
    );
    const results = connectClients(setupEnv, launch);
    if (results.length === 0)
      console.log(
        'No agent clients found (Claude Code, Codex, Cursor, Gemini CLI, Claude Desktop, Windsurf).'
      );
    for (const r of results)
      console.log(
        r.status === 'skipped'
          ? `  -  ${r.client}: skipped (${r.reason})`
          : `  ✓  ${r.client}: ${r.status === 'added' ? 'connected' : r.status === 'updated' ? 'updated' : 'already connected'}`
      );
  }
  process.exit((await interactiveLogin(console.log, join)) ? 0 : 1);
}

// `status`: the team this machine is signed in to and whether each agent
// client can reach Dispatch, with the fix for any that cannot.
if (argv[0] === 'status') {
  const { readTeamFile } = await import('./hub/team.js');
  const { clientHealth, defaultSetupEnv } = await import('./setup.js');
  const team = readTeamFile();
  console.log(
    team === null
      ? 'Team: not signed in. Agents here reach only each other; run `npx -y @dispatch-foo/mcp login`, or `join <invite link>`.'
      : `Team: ${team.team.name} as ${team.handle} (${team.server})`
  );
  const health = clientHealth(defaultSetupEnv());
  if (health.length === 0)
    console.log(
      'No agent clients found (Claude Code, Codex, Cursor, Gemini CLI, Claude Desktop, Windsurf).'
    );
  for (const h of health)
    console.log(
      h.state === 'connected'
        ? `  ✓  ${h.client}: connected`
        : `  ✗  ${h.client}: ${h.state}${h.detail === undefined ? '' : ` (${h.detail})`}`
    );
  process.exit(
    team !== null && health.every((h) => h.state === 'connected') ? 0 : 1
  );
}

if (argv[0] === 'logout') {
  const { logout } = await import('./login.js');
  console.log(
    logout()
      ? 'Signed out of your team. Your agents still reach each other on this machine.'
      : 'This machine was not signed in to a team.'
  );
  process.exit(0);
}

// `hub` runs the machine hub in the foreground; MCP servers start it detached.
if (argv[0] === 'hub') {
  const { runHub } = await import('./hub/main.js');
  await runHub();
  process.exit(0);
}

// Any other word is a mistake, not a request to serve MCP: serving would wait
// on stdin and, run with none, exit 0 as though the command had worked.
if (argv[0] !== undefined && !argv[0].startsWith('-')) {
  console.error(`dispatch-mcp: unknown command "${argv[0]}"\n\n${USAGE}`);
  process.exit(1);
}

const parsed = parseRootArg(argv);
if (!parsed.ok) {
  console.error(`dispatch-mcp: ${parsed.error}`);
  process.exit(1);
}

await runStdioServer(parsed.root);

// All of stdin, or '' when it is a terminal (a hook run by hand).
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
