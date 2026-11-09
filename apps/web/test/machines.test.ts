import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TeamDb } from '../src/db.js';
import type { TeamHubs } from '../src/hub.js';
import { machinesHandler } from '../src/machines.js';
import { webUserOf } from '../src/web.js';

// Your own machines from the web: the list shows only yours, a machine page
// and its API answer only for the person who signed that machine in (and
// only with a view token minted for them), and requests reach the machine
// as `http` calls whose answers come back decoded.

const ORIGIN = 'https://app.test';
let db: TeamDb;
let dist: string;
let calls: { device: string; kind: string; body: unknown }[];
let online: Set<string>;
let answer: (
  kind: string,
  body: unknown
) => {
  ok: boolean;
  result?: unknown;
  error?: string;
};

// The hub stand-in: a connection for each online device that records calls.
function hubs(): TeamHubs {
  return {
    of: () => ({
      connection: (deviceId: string) =>
        online.has(deviceId)
          ? {
              call: (kind: string, body: unknown) => {
                calls.push({ device: deviceId, kind, body });
                return Promise.resolve(answer(kind, body));
              },
            }
          : null,
    }),
  } as unknown as TeamHubs;
}

function device(userId: string, teamId: string): string {
  const { deviceCode, userCode } = db.startDeviceCode('laptop');
  db.approveDevice(userCode, userId, teamId);
  const claimed = db.claimDevice(deviceCode);
  if (claimed.status !== 'ok') throw new Error(claimed.status);
  return claimed.device.id;
}

let ada: { id: string; cookie: string; device: string };
let bob: { id: string; cookie: string; device: string };
let handler: ReturnType<typeof machinesHandler>;

beforeEach(() => {
  db = new TeamDb(':memory:');
  dist = mkdtempSync(join(tmpdir(), 'web-machines-dist-'));
  writeFileSync(
    join(dist, 'index.html'),
    '<html><head></head><body></body></html>'
  );
  calls = [];
  online = new Set();
  answer = (kind) =>
    kind === 'projects'
      ? {
          ok: true,
          result: { projects: [{ key: 'a1b2c3d4e5f60718', name: 'dispatch' }] },
        }
      : {
          ok: true,
          result: {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'set-cookie': 'x=1',
            },
            body: Buffer.from('{"tier":"decide"}').toString('base64'),
          },
        };
  const a = db.upsertGithubUser(1, 'ada', null);
  const b = db.upsertGithubUser(2, 'bob', null);
  const adaTeam = db.createTeam('Ada', a.id);
  const bobTeam = db.createTeam('Bob', b.id);
  ada = {
    id: a.id,
    cookie: `dt_session=${db.startWebSession(a.id)}`,
    device: device(a.id, adaTeam.id),
  };
  bob = {
    id: b.id,
    cookie: `dt_session=${db.startWebSession(b.id)}`,
    device: device(b.id, bobTeam.id),
  };
  online.add(ada.device);
  online.add(bob.device);
  handler = machinesHandler({
    db,
    hubs: hubs(),
    origin: ORIGIN,
    distDir: dist,
    userOf: (req) => webUserOf(db, req),
    signIn: () => new Response('sign in', { status: 200 }),
  });
});

afterEach(() => {
  db.close();
  rmSync(dist, { recursive: true, force: true });
});

const get = (path: string, cookie: string, token?: string) =>
  handler.fetch(
    new Request(`${ORIGIN}${path}`, {
      headers: {
        cookie,
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
    })
  );

async function openPage(who: { cookie: string; device: string }) {
  const res = await get(`/m/${who.device}/a1b2c3d4e5f60718/`, who.cookie);
  const html = await res!.text();
  const token = /"agentToken":"([^"]+)"/.exec(html)?.[1] ?? '';
  return { res: res!, html, token };
}

describe('your machines from the web', () => {
  it('lists only your own machines and their projects', async () => {
    const page = await (await get('/machines', ada.cookie))!.text();
    expect(page).toContain(`/m/${ada.device}/a1b2c3d4e5f60718/`);
    expect(page).not.toContain(bob.device);
  });

  it("serves a machine's page only to its owner", async () => {
    const own = await openPage(ada);
    expect(own.res.status).toBe(200);
    expect(own.html).toContain(
      `"baseUrl":"${ORIGIN}/m/${ada.device}/a1b2c3d4e5f60718"`
    );
    expect(own.html).toContain('"appToken":null');
    // Named by the project's own name, which the machine reports.
    expect(own.html).toContain(
      `"root":"/m/${ada.device}/a1b2c3d4e5f60718/dispatch"`
    );
    const theirs = await get(`/m/${bob.device}/a1b2c3d4e5f60718/`, ada.cookie);
    expect(theirs!.status).toBe(404);
  });

  it('forwards API calls as http frames and decodes the answer', async () => {
    const { token } = await openPage(ada);
    const res = await get(
      `/m/${ada.device}/a1b2c3d4e5f60718/api/whoami?x=1`,
      ada.cookie,
      token
    );
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ tier: 'decide' });
    expect(res!.headers.get('set-cookie')).toBeNull();
    expect(calls.at(-1)).toMatchObject({
      device: ada.device,
      kind: 'http',
      body: {
        project: 'a1b2c3d4e5f60718',
        method: 'GET',
        path: '/api/whoami?x=1',
      },
    });
  });

  it("refuses a token in someone else's session, or for another machine", async () => {
    const { token } = await openPage(ada);
    const stolen = await get(
      `/m/${ada.device}/a1b2c3d4e5f60718/api/whoami`,
      bob.cookie,
      token
    );
    expect(stolen!.status).toBe(401);
    const elsewhere = await get(
      `/m/${bob.device}/a1b2c3d4e5f60718/api/whoami`,
      ada.cookie,
      token
    );
    expect(elsewhere!.status).toBe(401);
    expect(calls.filter((c) => c.kind === 'http')).toEqual([]);
  });

  it('says so when the machine is offline or refuses', async () => {
    const { token } = await openPage(ada);
    answer = () => ({ ok: false, error: 'web access is off on this machine' });
    const refused = await get(
      `/m/${ada.device}/a1b2c3d4e5f60718/api/whoami`,
      ada.cookie,
      token
    );
    expect(refused!.status).toBe(502);
    expect(await refused!.json()).toEqual({
      error: 'web access is off on this machine',
    });
    answer = () => ({ ok: true, result: { status: 'oops' } });
    const broken = await get(
      `/m/${ada.device}/a1b2c3d4e5f60718/api/whoami`,
      ada.cookie,
      token
    );
    expect(broken!.status).toBe(502);
    online.delete(ada.device);
    const offline = await get(
      `/m/${ada.device}/a1b2c3d4e5f60718/api/whoami`,
      ada.cookie,
      token
    );
    expect(offline!.status).toBe(404);
  });
});
