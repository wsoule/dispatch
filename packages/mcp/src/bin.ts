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
import { runStdioServer } from './server.js';

// Every call to dispatchd carries a bearer token to http://127.0.0.1, and a
// proxy in the agent's environment (HTTP_PROXY, ALL_PROXY) would otherwise
// receive it: before any fetch, the loopback addresses join NO_PROXY.
exemptLoopbackFromProxy();

const argv = process.argv.slice(2);

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
if (argv[0] === 'login' || argv[0] === 'setup') {
  const { interactiveLogin } = await import('./login.js');
  if (argv[0] === 'setup') {
    const { connectClients, defaultSetupEnv, installRuntime } =
      await import('./setup.js');
    const { MCP_SERVER_VERSION } = await import('./server.js');
    const setupEnv = defaultSetupEnv();
    const launch = installRuntime(setupEnv, MCP_SERVER_VERSION);
    console.log(
      launch.command === 'npx'
        ? '  -  Could not install into ~/.dispatch/runtime; clients will start Dispatch with npx'
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
  process.exit((await interactiveLogin(console.log)) ? 0 : 1);
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
