import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TeamService } from '../src/server.js';
import { startTeamService } from '../src/server.js';

// Two people's machines, each running the real machine hub from the monorepo
// build, signed in to one team: their agent sessions reach each other through
// the team hub. Uses this repo's packages/mcp build (or DISPATCH_MONOREPO's);
// skipped when that build is missing.

const MONOREPO =
  process.env.DISPATCH_MONOREPO ?? join(import.meta.dir, '../../..');
const BIN = join(MONOREPO, 'packages/mcp/dist/bin.js');
const run = existsSync(BIN) ? describe : describe.skip;

interface Machine {
  home: string;
  proc: ReturnType<typeof Bun.spawn>;
  port: number;
  token: string;
}

let service: TeamService;
let dataDir: string;
let server: string;
const machines: Machine[] = [];

async function until<T>(
  what: string,
  check: () => Promise<T | null | undefined | false>,
  ms = 20_000
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

async function machine(
  login: string,
  githubId: number,
  teamId: string
): Promise<Machine> {
  const db = service.db;
  const user = db.upsertGithubUser(githubId, login, null);
  const { deviceCode, userCode } = db.startDeviceCode(`hub of ${login}`);
  db.approveDevice(userCode, user.id, teamId);
  const claimed = db.claimDevice(deviceCode);
  if (claimed.status !== 'ok') throw new Error(claimed.status);
  const home = mkdtempSync(join(tmpdir(), `mesh-${login}-`));
  mkdirSync(join(home, '.dispatch', 'hub'), { recursive: true });
  writeFileSync(
    join(home, '.dispatch', 'hub', 'team.json'),
    JSON.stringify({
      server,
      token: claimed.token,
      handle: claimed.user.login,
      team: { id: claimed.team.id, name: claimed.team.name },
      device: claimed.device.id,
    })
  );
  const proc = Bun.spawn(['node', BIN, 'hub'], {
    env: { ...process.env, DISPATCH_HOME: home },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const info = await until(`${login}'s hub`, () => {
    const path = join(home, '.dispatch', 'hub', 'hub.json');
    return Promise.resolve(
      existsSync(path)
        ? (JSON.parse(readFileSync(path, 'utf8')) as {
            port: number;
            token: string;
          })
        : null
    );
  });
  const m = { home, proc, port: info.port, token: info.token };
  machines.push(m);
  return m;
}

async function hubCall(
  m: Machine,
  path: string,
  token: string,
  body?: unknown
): Promise<Response> {
  return fetch(`http://127.0.0.1:${m.port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// A client identity and one session on a machine, as an MCP server would make.
async function session(
  m: Machine,
  client: string,
  sid: string
): Promise<{ address: string; token: string }> {
  const parent = (await (
    await hubCall(m, '/api/agents/register', m.token, {
      name: `${client}.mac`,
      client,
    })
  ).json()) as {
    address: string;
    token: string;
  };
  return (await (
    await hubCall(m, '/api/agents/register', m.token, {
      name: `${client}-${sid}`,
      client,
      parent: parent.address,
      parentToken: parent.token,
      meta: { repo: 'app', label: `${client} work` },
    })
  ).json()) as { address: string; token: string };
}

async function mailbox(
  m: Machine,
  token: string
): Promise<
  { message: { id: string; body: string; thread: string; from: string } }[]
> {
  const res = await hubCall(m, '/api/mailbox', token);
  return (
    (await res.json()) as {
      items: {
        message: { id: string; body: string; thread: string; from: string };
      }[];
    }
  ).items;
}

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'mesh-team-'));
  service = startTeamService({
    port: 0,
    hostname: '127.0.0.1',
    dataDir,
    origin: 'http://team.test',
    githubClientId: null,
    githubClientSecret: null,
    devLogin: true,
    teamSecret: null,
  });
  server = `http://127.0.0.1:${service.port}`;
});

afterAll(async () => {
  for (const m of machines) {
    m.proc.kill();
    rmSync(m.home, { recursive: true, force: true });
  }
  await service.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

run('agents across teammates’ machines', () => {
  it('a Codex session on one machine and a Claude Code session on another trade mail', async () => {
    const owner = service.db.upsertGithubUser(1, 'ada', null);
    const team = service.db.createTeam('Core', owner.id);
    const bobUser = service.db.upsertGithubUser(2, 'bob', null);
    service.db.acceptInvite(
      service.db.createInvite(team.id, owner.id),
      bobUser.id
    );

    const ada = await machine('ada', 1, team.id);
    const bob = await machine('bob', 2, team.id);
    const adaSession = await session(ada, 'claude-code', 'aaaaaa');
    const bobSession = await session(bob, 'codex', 'bbbbbb');
    expect(adaSession.address).toBe('agent:ada/claude-code-aaaaaa');
    expect(bobSession.address).toBe('agent:bob/codex-bbbbbb');

    // Each machine learns the other's agents through the team.
    await until("bob's session on ada's machine", async () => {
      const res = await hubCall(ada, '/api/agents/roster', ada.token);
      const { agents } = (await res.json()) as {
        agents: { address: string; online: boolean }[];
      };
      return agents.some((a) => a.address === bobSession.address);
    });

    const sent = await hubCall(bob, '/api/messages', bobSession.token, {
      to: [adaSession.address],
      kind: 'message',
      body: 'can you review the auth change?',
    });
    expect(sent.status).toBe(201);
    const question = (
      (await sent.json()) as { message: { id: string; thread: string } }
    ).message;

    const arrived = await until('the message on ada’s machine', async () =>
      (await mailbox(ada, adaSession.token)).find(
        (i) => i.message.body === 'can you review the auth change?'
      )
    );
    expect(arrived.message.from).toBe(bobSession.address);

    const reply = await hubCall(
      ada,
      `/api/messages/${question.id}/reply`,
      adaSession.token,
      { body: 'looking now' }
    );
    expect(reply.status).toBe(201);
    const back = await until('the reply on bob’s machine', async () =>
      (await mailbox(bob, bobSession.token)).find(
        (i) => i.message.body === 'looking now'
      )
    );
    expect(back.message.thread).toBe(question.thread);

    // The team page lists both sessions, live.
    const live = service.hubs.sessions(team.id);
    expect(live.map((s) => s.address).sort()).toEqual([
      adaSession.address,
      bobSession.address,
    ]);
  }, 60_000);

  it('a machine cannot speak for a teammate’s address', async () => {
    const [, bob] = machines;
    if (bob === undefined) throw new Error('needs the first test');
    const forged = await hubCall(bob, '/api/agents/register', bob.token, {
      name: 'claude-code.mac',
      client: 'x',
    });
    // The address is bob's own namespace, whatever name it takes.
    expect(
      ((await forged.json()) as { address?: string }).address ?? ''
    ).toStartWith('agent:bob/');
  });
});
