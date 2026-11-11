import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TeamDb } from '../src/db.js';
import type { TeamLinear } from '../src/linear.js';
import type { Email, Mailer } from '../src/mailer.js';
import { inviteEmail, looksLikeEmail, resendMailer } from '../src/mailer.js';
import { webHandler } from '../src/web.js';

// Teammate onboarding (#237, #238): an admin invites by email, the teammate
// runs one command (`dispatch-mcp join <link>`) and clicks once in the
// browser to join the team and sign the machine in; the team page shows
// where each person is; a Linear workspace member can join a linked team.

const ORIGIN = 'http://team.test';
let db: TeamDb;
let sent: Email[];
let mailFails: boolean;
let linkedOrg: string | null;
let handle: (req: Request) => Promise<Response | null>;

function handler(mailer: Mailer | null) {
  return webHandler({
    db,
    config: {
      origin: ORIGIN,
      githubClientId: null,
      githubClientSecret: null,
      devLogin: true,
    },
    sessions: () => [
      { address: 'agent:ada/claude-code', client: 'claude', online: true },
    ],
    mailer,
    linear: {
      available: true,
      status: () => null,
      linkedOrgId: () => linkedOrg,
      linkedTeams: (orgs: string[]) =>
        linkedOrg !== null && orgs.includes(linkedOrg)
          ? db
              .teamsOf(db.webSessionUser(adaSession)?.id ?? '')
              .map((t) => ({ teamId: t.id, org: 'Acme' }))
          : [],
    } as unknown as TeamLinear,
  });
}

let adaSession = '';
beforeEach(() => {
  db = new TeamDb(':memory:');
  sent = [];
  mailFails = false;
  linkedOrg = null;
  handle = handler({
    send: (email) => {
      if (mailFails) return Promise.reject(new Error('down'));
      sent.push(email);
      return Promise.resolve();
    },
  });
});
afterEach(() => db.close());

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await handle(new Request(`${ORIGIN}${path}`, init));
  if (res === null) throw new Error(`no route ${path}`);
  return res;
}

async function signIn(login: string): Promise<string> {
  const res = await call(`/auth/dev?login=${login}`);
  const set = res.headers.get('set-cookie') ?? '';
  return set.slice(0, set.indexOf(';'));
}

function post(path: string, cookie: string, fields: Record<string, string>) {
  return call(path, {
    method: 'POST',
    headers: {
      cookie,
      origin: ORIGIN,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields).toString(),
  });
}

const page = async (path: string, cookie: string) =>
  (await call(path, { headers: { cookie } })).text();

async function team(cookie: string): Promise<string> {
  return (
    (await post('/teams', cookie, { name: 'Core' })).headers.get('location') ??
    ''
  ).slice('/teams/'.length);
}

describe('inviting by email', () => {
  it('sends the link and the one join command, and lists the invite', async () => {
    const ada = await signIn('ada');
    const teamId = await team(ada);
    const res = await post(`/teams/${teamId}/invites`, ada, {
      email: 'bob@example.com',
    });
    const back = res.headers.get('location') ?? '';
    expect(back).toContain('sent=bob%40example.com');
    expect(sent).toHaveLength(1);
    const token = new URL(back, ORIGIN).searchParams.get('invite') ?? '';
    expect(sent[0]?.to).toBe('bob@example.com');
    expect(sent[0]?.text).toContain(`${ORIGIN}/join/${token}`);
    expect(sent[0]?.text).toContain(
      `npx -y @dispatch-foo/mcp join ${ORIGIN}/join/${token}`
    );

    const html = await page(back, ada);
    expect(html).toContain('Sent to bob@example.com');
    expect(html).toContain('<span class="muted">bob@example.com</span>');
    expect(html).toContain('not joined yet');
  });

  it('still makes the link when the email fails, and says so', async () => {
    mailFails = true;
    const ada = await signIn('ada');
    const teamId = await team(ada);
    const back =
      (
        await post(`/teams/${teamId}/invites`, ada, { email: 'b@example.com' })
      ).headers.get('location') ?? '';
    expect(back).toContain('invite=');
    expect(back).toContain('mail_error=');
    expect(await page(back, ada)).toContain('send the link yourself');
  });

  it('refuses something that is not an email, and makes no invite', async () => {
    const ada = await signIn('ada');
    const teamId = await team(ada);
    const back =
      (
        await post(`/teams/${teamId}/invites`, ada, { email: 'x@y' })
      ).headers.get('location') ?? '';
    expect(back).not.toContain('invite=');
    expect(db.openInvites(teamId)).toHaveLength(0);
  });

  it('makes a plain link with no email', async () => {
    const ada = await signIn('ada');
    const teamId = await team(ada);
    const back =
      (await post(`/teams/${teamId}/invites`, ada, {})).headers.get(
        'location'
      ) ?? '';
    expect(back).toContain('invite=');
    expect(sent).toHaveLength(0);
  });
});

describe('joining with `dispatch-mcp join <link>`', () => {
  it('joins the team and signs the machine in with one approval', async () => {
    const ada = await signIn('ada');
    const teamId = await team(ada);
    const token = db.createInvite(
      teamId,
      db.webSessionUser(ada.slice('dt_session='.length))!.id,
      'bob@example.com'
    );
    const started = (await (
      await call('/api/device/code', {
        method: 'POST',
        body: JSON.stringify({ client: 'dispatch-mcp', invite: token }),
      })
    ).json()) as { device_code: string; user_code: string };

    // Bob is in no team yet: the page offers to join the invite's team.
    const bob = await signIn('bob');
    const html = await page(`/device?code=${started.user_code}`, bob);
    expect(html).toContain('Join Core and sign in');

    await post('/device', bob, {
      code: started.user_code,
      team: teamId,
      decision: 'approve',
    });
    const done = (await (
      await call('/api/device/token', {
        method: 'POST',
        body: JSON.stringify({ device_code: started.device_code }),
      })
    ).json()) as { handle: string; team: { id: string } };
    expect(done).toMatchObject({ handle: 'bob', team: { id: teamId } });
    expect(db.openInvites(teamId)).toHaveLength(0);
  });

  it('works after the link was already used in the browser by the same person', async () => {
    const ada = await signIn('ada');
    const teamId = await team(ada);
    const adaId = db.webSessionUser(ada.slice('dt_session='.length))!.id;
    const token = db.createInvite(teamId, adaId);
    const bob = await signIn('bob');
    await post(`/join/${token}`, bob, {});
    const { userCode } = db.startDeviceCode('laptop', token);
    const bobId = db.webSessionUser(bob.slice('dt_session='.length))!.id;
    expect(db.approveDeviceFor(userCode, bobId, teamId)).toEqual({ ok: true });
  });

  it('does not let an invite used by someone else admit another person', async () => {
    const ada = await signIn('ada');
    const teamId = await team(ada);
    const adaId = db.webSessionUser(ada.slice('dt_session='.length))!.id;
    const token = db.createInvite(teamId, adaId);
    const bob = await signIn('bob');
    await post(`/join/${token}`, bob, {});
    const { userCode } = db.startDeviceCode('laptop', token);
    const eve = db.upsertGithubUser(99, 'eve', null);
    expect(db.approveDeviceFor(userCode, eve.id, teamId).ok).toBe(false);
    expect(db.role(teamId, eve.id)).toBeNull();
  });
});

describe('the team page checklist', () => {
  it('shows each person joined, machine and agent, with the next step', async () => {
    const ada = await signIn('ada');
    const teamId = await team(ada);
    const html = await page(`/teams/${teamId}`, ada);
    expect(html).toContain('✓ joined');
    expect(html).toContain('○ machine signed in');
    // The test's sessions include agent:ada/claude-code.
    expect(html).toContain('✓ 1 agent connected');
    expect(html).toContain('Next: run npx -y @dispatch-foo/mcp setup');
  });
});

describe('joining a team linked to your Linear workspace', () => {
  it('offers Join on Home and admits a workspace member', async () => {
    const ada = await signIn('ada');
    adaSession = ada.slice('dt_session='.length);
    const teamId = await team(ada);
    linkedOrg = 'org_acme';
    const bob = await signIn('bob');
    const bobId = db.webSessionUser(bob.slice('dt_session='.length))!.id;

    expect(await page('/', bob)).not.toContain(`/teams/${teamId}/join`);
    expect((await post(`/teams/${teamId}/join`, bob, {})).status).toBe(403);

    db.noteLinearOrg(bobId, { id: 'org_acme', name: 'Acme' });
    expect(await page('/', bob)).toContain(`/teams/${teamId}/join`);
    const joined = await post(`/teams/${teamId}/join`, bob, {});
    expect(joined.headers.get('location')).toBe(`/teams/${teamId}`);
    expect(db.role(teamId, bobId)).toBe('member');
  });
});

describe('the Resend mailer', () => {
  it('posts one email to the Resend API', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const mailer = resendMailer('re_test', 'Dispatch <invites@example.com>', ((
      url: string,
      init: RequestInit
    ) => {
      calls.push({ url, init });
      return Promise.resolve(Response.json({ id: 'em_1' }));
    }) as unknown as typeof fetch);
    await mailer.send(
      inviteEmail({ to: 'b@example.com', team: 'Core', by: 'Ada', link: 'L' })
    );
    expect(calls[0]?.url).toBe('https://api.resend.com/emails');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer re_test');
    const body = JSON.parse(calls[0]?.init.body as string) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      from: 'Dispatch <invites@example.com>',
      to: ['b@example.com'],
      subject: 'Ada invited you to Core on Dispatch',
    });
  });

  it('reports a refusal with Resend’s message', async () => {
    const mailer = resendMailer('re_test', 'x@example.com', (() =>
      Promise.resolve(
        Response.json(
          { name: 'validation_error', message: 'domain not verified' },
          { status: 403 }
        )
      )) as unknown as typeof fetch);
    await expect(
      mailer.send(inviteEmail({ to: 'b@e.co', team: 'T', by: 'A', link: 'L' }))
    ).rejects.toThrow('domain not verified');
  });

  it('accepts one plain address only', () => {
    expect(looksLikeEmail('bob@example.com')).toBe(true);
    expect(looksLikeEmail('a@b.co, c@d.co')).toBe(false);
    expect(looksLikeEmail('Bob <bob@example.com>')).toBe(false);
  });
});
