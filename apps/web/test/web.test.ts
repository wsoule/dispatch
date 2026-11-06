import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TeamDb } from '../src/db.js';
import { webHandler } from '../src/web.js';

const ORIGIN = 'http://team.test';
let db: TeamDb;
let handle: (req: Request) => Promise<Response | null>;

beforeEach(() => {
  db = new TeamDb(':memory:');
  handle = webHandler({
    db,
    config: {
      origin: ORIGIN,
      githubClientId: null,
      githubClientSecret: null,
      devLogin: true,
    },
    sessions: () => [],
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

function post(
  path: string,
  cookie: string,
  fields: Record<string, string>,
  origin = ORIGIN
) {
  return call(path, {
    method: 'POST',
    headers: {
      cookie,
      origin,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields).toString(),
  });
}

describe('team web', () => {
  it('signs a device in end to end', async () => {
    const ada = await signIn('ada');
    const created = await post('/teams', ada, { name: 'Core' });
    const teamPath = created.headers.get('location') ?? '';
    expect(teamPath).toMatch(/^\/teams\/team_/);
    const teamId = teamPath.slice('/teams/'.length);

    const started = (await (
      await call('/api/device/code', {
        method: 'POST',
        body: JSON.stringify({ client: 'dispatch-mcp' }),
      })
    ).json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
    };
    expect(started.verification_uri).toBe(`${ORIGIN}/device`);

    const poll = () =>
      call('/api/device/token', {
        method: 'POST',
        body: JSON.stringify({ device_code: started.device_code }),
      });
    expect(await (await poll()).json()).toEqual({
      error: 'authorization_pending',
    });

    const page = await call(`/device?code=${started.user_code}`, {
      headers: { cookie: ada },
    });
    expect(await page.text()).toContain('dispatch-mcp');
    await post('/device', ada, {
      code: started.user_code,
      team: teamId,
      decision: 'approve',
    });

    const done = (await (await poll()).json()) as {
      token: string;
      handle: string;
      team: { id: string };
    };
    expect(done.handle).toBe('ada');
    expect(done.team.id).toBe(teamId);
    expect(db.deviceByToken(done.token)?.teamId).toBe(teamId);
  });

  it('refuses a form posted from another origin', async () => {
    const ada = await signIn('ada');
    const res = await post(
      '/teams',
      ada,
      { name: 'Evil' },
      'https://evil.example'
    );
    expect(res.status).toBe(403);
    expect(
      db.teamsOf(
        db.webSessionUser(decodeURIComponent(ada.split('=')[1] ?? ''))!.id
      )
    ).toHaveLength(0);
  });

  it('shows the sign-in page to a stranger and keeps teams private', async () => {
    expect(await (await call('/')).text()).toContain('Sign in with GitHub');
    const ada = await signIn('ada');
    const bob = await signIn('bob');
    const teamPath =
      (await post('/teams', ada, { name: 'Core' })).headers.get('location') ??
      '';
    expect((await call(teamPath, { headers: { cookie: bob } })).status).toBe(
      404
    );
  });

  it('joins a team through an invite link', async () => {
    const ada = await signIn('ada');
    const bob = await signIn('bob');
    const teamPath =
      (await post('/teams', ada, { name: 'Core' })).headers.get('location') ??
      '';
    const invited =
      (await post(`${teamPath}/invites`, ada, {})).headers.get('location') ??
      '';
    const token =
      new URL(`${ORIGIN}${invited}`).searchParams.get('invite') ?? '';
    const joined = await post(`/join/${token}`, bob, {});
    expect(joined.headers.get('location')).toBe(teamPath);
    expect(
      await (await call(teamPath, { headers: { cookie: bob } })).text()
    ).toContain('Core');
  });

  it('escapes what people typed', async () => {
    const ada = await signIn('ada');
    const teamPath =
      (await post('/teams', ada, { name: '<script>x</script>' })).headers.get(
        'location'
      ) ?? '';
    const body = await (
      await call(teamPath, { headers: { cookie: ada } })
    ).text();
    expect(body).not.toContain('<script>x');
    expect(body).toContain('&lt;script&gt;');
  });
});

describe('sign-in redirects', () => {
  it('never sends a person off the site after signing in', async () => {
    for (const next of [
      '//evil.example',
      '/\\evil.example',
      'https://evil.example',
      '/\\/evil.example',
      '/\t/evil.example',
      '/\n/evil.example',
    ]) {
      const res = await call(
        `/auth/dev?login=ada&next=${encodeURIComponent(next)}`
      );
      expect(res.headers.get('location')).toBe('/');
    }
    const ok = await call(
      `/auth/dev?login=ada&next=${encodeURIComponent('/teams')}`
    );
    expect(ok.headers.get('location')).toBe('/teams');
  });
});
