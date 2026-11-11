import { TaskStore } from '@dispatch-foo/core';
import { SYSTEM_ADDRESS } from '@dispatch-foo/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { hubMaySpeakFor, isHubRow } from '../../src/messaging/hubLink.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { useTestAuth } from '../testAuth.js';

// The project's mirror of the machine hub's agents: new clients wait on the
// project's gate, sessions follow their client, revocations stick.

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initGitRepo('dispatch-hub-link-');
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    writeDaemonFile: false,
    hubLink: true,
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const CLIENT = 'agent:test/codex.mac';
const SESSION = 'agent:test/codex-aaaaaa';
const client = {
  address: CLIENT,
  displayName: 'codex.mac',
  client: 'codex',
  status: 'approved',
};
const session = {
  address: SESSION,
  displayName: 'codex-aaaaaa',
  client: 'codex',
  status: 'approved',
  parent: CLIENT,
  meta: { repo: 'x' },
};

const roster = (agents: unknown[]) =>
  handle.hubLink!.receive('agents', { agents });
const row = (address: string) => handle.messaging.store.getAgent(address);
const decide = (address: string, verb: 'approve' | 'revoke') =>
  fetch(`${baseUrl}/api/agents/${encodeURIComponent(address)}/${verb}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });

describe('hub roster mirror', () => {
  it('holds a new client at the gate and its sessions until it passes', async () => {
    await roster([client, session]);
    expect(row(CLIENT)?.status).toBe('pending');
    expect(row(SESSION)?.status).toBe('pending');
    const open = await fetch(`${baseUrl}/api/decisions/open`);
    const { items } = (await open.json()) as {
      items: { data?: { type?: string; agent?: string } }[];
    };
    expect(
      items.some(
        (i) => i.data?.type === 'agent-registration' && i.data.agent === CLIENT
      )
    ).toBe(true);

    await decide(CLIENT, 'approve');
    await roster([client, session]);
    expect(row(SESSION)?.status).toBe('approved');
  });

  it('approves a new client at once when the project opted in', async () => {
    // #237: the person's own Claude Code agents waited on "Needs you".
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'messaging:\n  approveMachineAgents: auto\n'
    );
    await roster([client, session]);
    expect(row(CLIENT)?.status).toBe('approved');
    await roster([client, session]);
    expect(row(SESSION)?.status).toBe('approved');
    const open = await fetch(`${baseUrl}/api/decisions/open`);
    const { items } = (await open.json()) as {
      items: { data?: { agent?: string } }[];
    };
    expect(items.some((i) => i.data?.agent === CLIENT)).toBe(false);
  });

  it('keeps a revoked session revoked through later rosters', async () => {
    await roster([client, session]);
    await decide(CLIENT, 'approve');
    await roster([client, session]);
    await decide(SESSION, 'revoke');
    await roster([client]);
    expect(row(SESSION)?.status).toBe('revoked');
    await roster([client, session]);
    expect(row(SESSION)?.status).toBe('revoked');
  });

  it('turns a session the project knew directly into a mirror, status kept', async () => {
    const register = (body: object) =>
      fetch(`${baseUrl}/api/agents/register`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${handle.tokens.agentToken}`,
        },
        body: JSON.stringify(body),
      });
    const parent = (await (
      await register({ name: 'codex.mac', client: 'codex' })
    ).json()) as { address: string; token: string };
    await decide(parent.address, 'approve');
    await register({
      name: 'codex-aaaaaa',
      client: 'codex',
      parent: parent.address,
      parentToken: parent.token,
    });
    expect(isHubRow(row(SESSION)!)).toBe(false);
    await roster([client, session]);
    expect(isHubRow(row(SESSION)!)).toBe(true);
    expect(row(SESSION)?.status).toBe('approved');
    // The client identity this project approved directly stays as it was.
    expect(isHubRow(row(CLIENT)!)).toBe(false);
  });

  it('lets the hub speak only for the agents it homes', async () => {
    await roster([client, session]);
    const store = handle.messaging.store;
    expect(hubMaySpeakFor(store, SESSION)).toBe(true);
    expect(hubMaySpeakFor(store, SYSTEM_ADDRESS)).toBe(true);
    expect(hubMaySpeakFor(store, 'human:test')).toBe(false);
    expect(hubMaySpeakFor(store, 'run:r-abc123')).toBe(false);
    expect(hubMaySpeakFor(store, 'agent:test/overseer')).toBe(false);
  });
});
