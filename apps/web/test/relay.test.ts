import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TeamDb } from '../src/db.js';
import type { Device } from '../src/db.js';
import { TeamHub } from '../src/hub.js';

// Three machines on one team, driving the team hub's frames directly: a
// teammate's machine must not reuse another machine's message id to route
// delivery reports (or settles) for that id to itself or anyone else.

interface Sent {
  id?: number;
  kind?: string;
  body?: unknown;
}

let dir: string;
let db: TeamDb;
let hub: TeamHub;
afterEach(() => {
  hub.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// Signs a member in on one device and returns it.
function signIn(userId: string, teamId: string): Device {
  const { deviceCode, userCode } = db.startDeviceCode('test');
  if (!db.approveDevice(userCode, userId, teamId)) throw new Error('approve');
  const c = db.claimDevice(deviceCode);
  if (c.status !== 'ok') throw new Error(c.status);
  return c.device;
}

// A machine hub on a fake socket: records the frames the team hub sends it
// and answers each request ok, as a real machine would.
function machine(device: Device, login: string) {
  const sent: Sent[] = [];
  let next = 1_000;
  const socket = {
    send(text: string) {
      const frame = JSON.parse(text) as Sent;
      sent.push(frame);
      if (typeof frame.id === 'number' && frame.kind !== undefined)
        queueMicrotask(
          () => void answer(JSON.stringify({ re: frame.id, ok: true }))
        );
    },
    close() {},
  };
  const conn = hub.connect(device, login, `@${login}-mac`, socket);
  if (conn === null) throw new Error('connect');
  const answer = (text: string) => hub.frame(conn, text);
  const send = async (kind: string, body: unknown) => {
    const id = next++;
    await hub.frame(conn, JSON.stringify({ id, kind, body }));
    return sent.find((f) => 're' in f && (f as { re: number }).re === id);
  };
  return { sent, send };
}

function mail(id: string, from: string, to: string) {
  return {
    message: {
      id,
      thread: id,
      replyTo: null,
      from,
      to: [to],
      kind: 'note',
      body: 'hi',
      refs: [],
      urgent: false,
      blocking: false,
      wake: 'none',
      createdAt: new Date().toISOString(),
    },
    targets: [{ recipient: to, via: 'direct', homes: [] }],
  };
}

function delivered(message: string, recipient: string) {
  return {
    entries: [
      {
        t: 'delivery',
        message,
        recipient,
        state: 'read',
        at: new Date().toISOString(),
      },
    ],
  };
}

// The state entries a machine received about one message.
function reportsAbout(sent: Sent[], message: string): unknown[] {
  return sent
    .filter((f) => f.kind === 'state')
    .flatMap(
      (f) =>
        (f.body as { entries: { message?: string; question?: string }[] })
          .entries
    )
    .filter((e) => e.message === message || e.question === message);
}

const settle = (question: string) => ({
  entries: [
    { t: 'settle', question, answer: 'x', at: new Date().toISOString() },
  ],
});

describe('TeamHub relay', () => {
  it('keeps a reused message id from redirecting reports', async () => {
    dir = mkdtempSync(join(tmpdir(), 'team-relay-'));
    db = new TeamDb(':memory:');
    const ada = db.upsertGithubUser(1, 'ada', null);
    const bob = db.upsertGithubUser(2, 'bob', null);
    const cy = db.upsertGithubUser(3, 'cy', null);
    const team = db.createTeam('Core', ada.id);
    for (const u of [bob, cy]) {
      const invite = db.createInvite(team.id, ada.id);
      if (!db.acceptInvite(invite, u.id).ok) throw new Error('invite');
    }
    hub = new TeamHub(team.id, dir, db);

    const a = machine(signIn(ada.id, team.id), 'ada');
    const b = machine(signIn(bob.id, team.id), 'bob');
    const c = machine(signIn(cy.id, team.id), 'cy');
    for (const [m, login] of [
      [a, 'ada'],
      [b, 'bob'],
      [c, 'cy'],
    ] as const)
      await m.send('agents', {
        agents: [
          {
            address: `agent:${login}/x`,
            displayName: 'x',
            client: 'codex',
            status: 'approved',
          },
        ],
      });

    // B mails A; A's machine sees B's message id.
    expect(
      await b.send('mail', mail('m-1', 'agent:bob/x', 'agent:ada/x'))
    ).toMatchObject({ ok: true, result: { status: 'relayed' } });

    // A's machine sends new mail to C under B's id: refused, never relayed.
    expect(
      await a.send('mail', mail('m-1', 'agent:ada/x', 'agent:cy/x'))
    ).toMatchObject({ ok: true, result: { status: 'refused' } });
    expect(c.sent.some((f) => f.kind === 'mail')).toBe(false);

    // C's report for that id does not reach B.
    await c.send('state', delivered('m-1', 'agent:cy/x'));
    // B's settle for it does not reach C either.
    await b.send('state', settle('m-1'));
    expect(reportsAbout(b.sent, 'm-1')).toEqual([]);
    expect(reportsAbout(c.sent, 'm-1')).toEqual([]);

    // A, the real recipient, still reports back to B, and B's settle
    // reaches A; A cannot settle B's question.
    await a.send('state', delivered('m-1', 'agent:ada/x'));
    expect(reportsAbout(b.sent, 'm-1')).toHaveLength(1);
    expect(reportsAbout(a.sent, 'm-1')).toHaveLength(1);
    await a.send('state', settle('m-1'));
    expect(reportsAbout(c.sent, 'm-1')).toEqual([]);

    // B sending again under its own id (a machine back online) still relays.
    expect(
      await b.send('mail', mail('m-1', 'agent:bob/x', 'agent:cy/x'))
    ).toMatchObject({ ok: true, result: { status: 'relayed' } });
  });
});
