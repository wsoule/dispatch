import { credentialsPath, TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, expect, it } from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { rawFetch, useTestAuth } from '../testAuth.js';

let home: string;
let root: string;
let handle: ServerHandle;
let base: string;
let cardServer: ReturnType<typeof Bun.serve>;
let cardUrl: string;
const originalHome = process.env.DISPATCH_HOME;
const json = { 'content-type': 'application/json' };

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-peer-routes-home-')));
  process.env.DISPATCH_HOME = home;
  root = initGitRepo('a2a-peer-routes-');
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    webDistDir: null,
  });
  useTestAuth(handle); // plain fetch now carries the operator app token
  base = `http://127.0.0.1:${handle.port}`;
  cardServer = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) =>
      Response.json({
        name: 'Fixture',
        description: 'A fixture.',
        version: '1',
        capabilities: { streaming: true },
        skills: [],
        supportedInterfaces: [
          {
            url: `${new URL(req.url).origin}/a2a/v1`,
            protocolBinding: 'HTTP+JSON',
            protocolVersion: '1.0',
          },
        ],
        securitySchemes: {
          bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } },
        },
        securityRequirements: [{ schemes: { bearer: { list: [] } } }],
      }),
  });
  cardUrl = `http://127.0.0.1:${cardServer.port}/.well-known/agent-card.json`;
});
afterEach(async () => {
  await cardServer.stop(true);
  await handle.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const addBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ alias: 'fixture', cardUrl, token: 'peer-secret', ...extra });

it('lets the operator add a loopback peer and never returns its credential', async () => {
  const res = await fetch(`${base}/api/a2a/peers`, {
    method: 'POST',
    headers: json,
    body: addBody(),
  });
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({
    alias: 'fixture',
    status: 'active',
    addedTier: 'operator',
    name: 'Fixture',
  });
  const list = await (await fetch(`${base}/api/a2a/peers`)).text();
  expect(list).toContain('fixture');
  expect(list).not.toContain('peer-secret');
});

it('refuses a decide-tier human a loopback card URL, and the request tier any add', async () => {
  const lead = handle.team.teammates.issue('ada', 'decide');
  const decide = await rawFetch(`${base}/api/a2a/peers`, {
    method: 'POST',
    headers: { ...json, authorization: `Bearer ${lead}` },
    body: addBody({
      cardUrl: cardUrl.replace('http://127.0.0.1', 'https://localhost'),
    }),
  });
  expect(decide.status).toBe(400);
  expect(((await decide.json()) as { field: string }).field).toBe('cardUrl');
  const member = handle.team.teammates.issue('bob', 'request');
  const request = await rawFetch(`${base}/api/a2a/peers`, {
    method: 'POST',
    headers: { ...json, authorization: `Bearer ${member}` },
    body: addBody(),
  });
  expect(request.status).toBe(403);
  const agent = await rawFetch(`${base}/api/a2a/peers`, {
    method: 'POST',
    headers: { ...json, authorization: `Bearer ${handle.tokens.agentToken}` },
    body: addBody(),
  });
  expect(agent.status).toBe(403);
});

it('answers 400 naming a field with the wrong type', async () => {
  const res = await fetch(`${base}/api/a2a/peers`, {
    method: 'POST',
    headers: json,
    body: addBody({ allowHttp: 'yes' }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { field: string }).field).toBe('allowHttp');
});

it('lets only a deciding human join a registered peer to a channel', async () => {
  await fetch(`${base}/api/a2a/peers`, {
    method: 'POST',
    headers: json,
    body: addBody(),
  });
  const member = handle.team.teammates.issue('bob', 'request');
  const lead = handle.team.teammates.issue('ada', 'decide');
  const join = (token: string, alias: string) =>
    rawFetch(`${base}/api/channels/ops/members`, {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${token}` },
      body: JSON.stringify({ member: `a2a:${alias}` }),
    });
  expect((await join(member, 'fixture')).status).toBe(403);
  expect((await join(lead, 'ghost')).status).toBe(404);
  expect((await join(lead, 'fixture')).status).toBe(204);
});

it('disables, enables and removes a peer, then answers 404', async () => {
  await fetch(`${base}/api/a2a/peers`, {
    method: 'POST',
    headers: json,
    body: addBody(),
  });
  const post = (path: string) =>
    fetch(`${base}/api/a2a/peers/fixture/${path}`, {
      method: 'POST',
      headers: json,
    });
  expect(await (await post('disable')).json()).toMatchObject({
    status: 'disabled',
  });
  expect(await (await post('enable')).json()).toMatchObject({
    status: 'active',
  });
  expect(await (await post('refresh')).json()).toMatchObject({
    status: 'active',
  });
  const del = () =>
    fetch(`${base}/api/a2a/peers/fixture`, { method: 'DELETE' });
  expect((await del()).status).toBe(204);
  expect((await del()).status).toBe(404);
});

it('answers 502 naming cardUrl when the card cannot be fetched', async () => {
  await cardServer.stop(true);
  const res = await fetch(`${base}/api/a2a/peers`, {
    method: 'POST',
    headers: json,
    body: addBody(),
  });
  expect(res.status).toBe(502);
  expect(((await res.json()) as { field: string }).field).toBe('cardUrl');
});

it('answers 409 with the fix when credentials.json cannot be parsed, and keeps the peer', async () => {
  await fetch(`${base}/api/a2a/peers`, {
    method: 'POST',
    headers: json,
    body: addBody(),
  });
  const good = readFileSync(credentialsPath(), 'utf8');
  writeFileSync(credentialsPath(), `${good.trimEnd()},\n`);
  const del = () =>
    fetch(`${base}/api/a2a/peers/fixture`, { method: 'DELETE' });
  const refused = await del();
  expect(refused.status).toBe(409);
  const { error } = (await refused.json()) as { error: string };
  expect(error).toContain('cannot be parsed; fix or move it');
  expect(error).not.toContain('peer-secret');
  expect(await (await fetch(`${base}/api/a2a/peers`)).text()).toContain(
    'fixture'
  );
  const add = await fetch(`${base}/api/a2a/peers`, {
    method: 'POST',
    headers: json,
    body: addBody({ alias: 'other' }),
  });
  expect(add.status).toBe(409);
  writeFileSync(credentialsPath(), good);
  expect((await del()).status).toBe(204);
});
